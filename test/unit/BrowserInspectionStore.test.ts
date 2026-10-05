/**
 * `InspectionStore` lifecycle with a fake Page — no browser.
 *
 * Covers the parts the real-Chrome integration test cannot see cheaply: the
 * named error when the page script hands back something that is not an array
 * (the exact pre-fix §3.2 symptom, where `page.evaluate` returned `undefined`),
 * and handle disposal on replace / drop / dropAll. Retained `ElementHandle`s
 * are Playwright objects: if a replaced snapshot's handles are not disposed,
 * each inspect leaks one and the browser is pinned open by references.
 */
import { describe, expect, it } from 'vitest';
import { InspectionStore } from '../../src/tools/browser/browserInspectionStore';
import type { ElementFacts } from '../../src/tools/browser/browserInspect';
import type { Page } from 'playwright-core';

const facts = (over: Partial<ElementFacts> = {}): ElementFacts => ({
  role: null,
  tag: 'button',
  type: null,
  ariaLabel: null,
  title: null,
  textContent: 'Save',
  placeholder: null,
  value: null,
  contentEditable: null,
  readOnly: false,
  disabled: false,
  ...over,
});

/** One inspected node: reports its facts, records whether it was disposed. */
function fakeHandle(recheck: unknown) {
  const handle = {
    disposed: false,
    dispose: () => {
      handle.disposed = true;
      return Promise.resolve();
    },
    evaluate: () => Promise.resolve(recheck),
  };
  return handle;
}

/**
 * A Page stand-in: `evaluate` returns whatever the scenario needs, and
 * `evaluateHandle` hands back the pinned node list the inspect callback would
 * have published. Cast to `Page` at the call sites — the real interface is far
 * larger than the three members this store touches.
 */
/**
 * A Page stand-in whose responses can be swapped between calls, so one Page
 * object can be inspected twice — which is what a replace has to be tested on,
 * since the store keys its snapshots by Page identity.
 */
function livePage(scenarios: Array<{ raw: unknown; nodes?: ReturnType<typeof fakeHandle>[] }>) {
  let call = 0;
  const published: string[] = [];
  const page = {
    url: () => 'https://example.test/',
    evaluate: () => Promise.resolve(scenarios[Math.min(call, scenarios.length - 1)]!.raw),
    evaluateHandle: (_fn: unknown, key: string) => {
      const nodes = scenarios[Math.min(call, scenarios.length - 1)]!.nodes ?? [];
      published.push(key);
      call++;
      const properties = new Map(
        nodes.map((node, i) => [String(i), { asElement: () => node }]),
      );
      return Promise.resolve({
        getProperties: () => Promise.resolve(properties),
        dispose: () => Promise.resolve(),
      });
    },
    published,
  };
  return page;
}

function fakePage(opts: { raw: unknown; nodes?: ReturnType<typeof fakeHandle>[]; url?: string }) {
  const page = livePage([opts]);
  return { ...page, url: () => opts.url ?? 'https://example.test/' };
}

const entry = (index: number, over: Partial<ElementFacts> = {}) => ({
  index,
  selector: `html > body:nth-of-type(1) > button:nth-of-type(${index + 1})`,
  bbox: { x: 0, y: 0, width: 10, height: 10 },
  facts: facts(over),
});

describe('InspectionStore page-result contract', () => {
  it('names a non-array page result instead of reporting an empty page', async () => {
    // The pre-fix §3.2 symptom exactly: the stringified callback resolved to
    // `undefined`, and the handler threw `Cannot read properties of undefined`.
    for (const raw of [undefined, null, {}, 'buttons']) {
      const store = new InspectionStore();
      const page = fakePage({ raw });
      await expect(store.capture(page as unknown as Page, 50)).rejects.toThrow(
        /browser_inspect: unexpected .* result from the page script/,
      );
    }
  });

  it('wraps a page-script throw in the named browser_inspect error', async () => {
    const store = new InspectionStore();
    const page = {
      url: () => 'https://example.test/',
      evaluate: () => Promise.reject(new Error('SecurityError: blocked')),
      evaluateHandle: () => Promise.resolve({ getProperties: () => Promise.resolve(new Map()), dispose: () => Promise.resolve() }),
    };
    await expect(store.capture(page as unknown as Page, 50)).rejects.toThrow(
      /browser_inspect: SecurityError: blocked/,
    );
  });

  it('returns [] for a page with no interactive elements', async () => {
    const store = new InspectionStore();
    const page = fakePage({ raw: [], nodes: [] });
    expect(await store.capture(page as unknown as Page, 50)).toEqual([]);
    expect(store.sizeFor(page as unknown as Page)).toBe(0);
  });

  it('drops a malformed entry rather than inventing one', async () => {
    const store = new InspectionStore();
    const nodes = [fakeHandle({}), fakeHandle({})];
    const page = fakePage({
      raw: [entry(0), { index: 1, selector: 42, facts: facts() }], // selector not a string
      nodes,
    });
    const listed = await store.capture(page as unknown as Page, 50);
    expect(listed.length).toBe(1);
    expect(listed[0]).toMatchObject({ index: 0, role: 'button', text: 'Save' });
  });
});

describe('InspectionStore handle lifecycle', () => {
  it('disposes the previous snapshot\'s handles when a new inspect replaces it', async () => {
    const store = new InspectionStore();
    const first = [fakeHandle({}), fakeHandle({})];
    const second = [fakeHandle({})];
    // ONE Page object, two inspects: the second must replace, not merge.
    const page = livePage([
      { raw: [entry(0), entry(1)], nodes: first },
      { raw: [entry(0)], nodes: second },
    ]);
    await store.capture(page as unknown as Page, 50);
    expect(store.sizeFor(page as unknown as Page)).toBe(2);

    await store.capture(page as unknown as Page, 50);
    expect(store.sizeFor(page as unknown as Page)).toBe(1);
    // The replaced handles are disposed; the live ones are not.
    expect(first.every((h) => h.disposed)).toBe(true);
    expect(second.every((h) => h.disposed)).toBe(false);
  });

  it('disposes handles on drop and on dropAll', async () => {
    const store = new InspectionStore();
    const nodes = [fakeHandle({}), fakeHandle({})];
    const page = fakePage({ raw: [entry(0), entry(1)], nodes });
    await store.capture(page as unknown as Page, 50);
    store.drop(page as unknown as Page);
    expect(nodes.every((h) => h.disposed)).toBe(true);
    expect(store.sizeFor(page as unknown as Page)).toBe(0);

    const more = [fakeHandle({})];
    await store.capture(fakePage({ raw: [entry(0)], nodes: more }) as unknown as Page, 50);
    store.dropAll();
    expect(more[0]!.disposed).toBe(true);
  });

  it('un-publishes the node array it stored in the page', async () => {
    // The inspect callback parks the nodes on `globalThis` so they can be read
    // back as handles. Leaving them there would keep every inspected node alive
    // in the page after the tool call returned.
    const store = new InspectionStore();
    const page = fakePage({ raw: [entry(0)], nodes: [fakeHandle({})] });
    await store.capture(page as unknown as Page, 50);
    expect(page.published.length).toBe(1);
  });
});

describe('InspectionStore index resolution without a snapshot', () => {
  it('refuses an index action that was never preceded by an inspect', async () => {
    const store = new InspectionStore();
    const page = fakePage({ raw: [] });
    await expect(store.resolve(page as unknown as Page, 3, 'click')).rejects.toThrow(
      /browser_click: no inspection for this tab; call browser_inspect first/,
    );
  });

  it('refuses an index outside the last inspection and names its size', async () => {
    const store = new InspectionStore();
    const page = fakePage({ raw: [entry(0)], nodes: [fakeHandle({ attached: false })] });
    await store.capture(page as unknown as Page, 50);
    await expect(store.resolve(page as unknown as Page, 99, 'hover')).rejects.toThrow(
      /browser_hover: no element at index 99 in the last inspection \(1 element\(s\)\)/,
    );
  });

  it('refuses a stale index when the tab has moved to another URL', async () => {
    const store = new InspectionStore();
    const nodes = [fakeHandle({ attached: true, visible: true, facts: facts() })];
    const page = fakePage({ raw: [entry(0)], nodes, url: 'https://example.test/one' });
    await store.capture(page as unknown as Page, 50);
    (page as unknown as { url: () => string }).url = () => 'https://example.test/two';
    await expect(store.resolve(page as unknown as Page, 0, 'click')).rejects.toThrow(
      /index 0 is stale — the tab moved from .* to .*; call browser_inspect again/,
    );
    // A stale snapshot is dropped, not kept: its handles must not linger.
    expect(nodes[0]!.disposed).toBe(true);
  });

  it('refuses a detached node with a named, actionable reason', async () => {
    const store = new InspectionStore();
    const nodes = [fakeHandle({ attached: false })];
    const page = fakePage({ raw: [entry(0)], nodes });
    await store.capture(page as unknown as Page, 50);
    await expect(store.resolve(page as unknown as Page, 0, 'click')).rejects.toThrow(
      /browser_click: the element at index 0 is no longer in the document; call browser_inspect again/,
    );
  });
});
