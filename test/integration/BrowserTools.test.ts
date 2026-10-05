import { afterAll, describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { BrowserSessionManager } from '../../src/tools/browser/BrowserSessionManager';
import { makeBrowserActionTools } from '../../src/tools/browser/browserActionTools';
import {
  buildBrowserToolContext,
  makeBrowserSessionTools,
} from '../../src/tools/browser/browserTools';
import type { MultimodalToolResult, RegisteredTool } from '../../src/tools/ToolRegistry';

/**
 * Browser tool integration gates. Runs real headless Chrome on the configured
 * system channel; skips with a message where no browser is present (CI on a box
 * without Chrome/Edge). A skipped test is reported as skipped — never counted as
 * a live pass.
 *
 * Phase 1 gate (original plan §5): a deterministic browser loop — browser_open →
 * browser_screenshot (assert the multimodal shape) → browser_click (a known
 * element) → browser_screenshot (assert the visible state changed).
 *
 * Fix-plan Phase 1 gates (docs/plans/DESKTOP_BROWSER_TOOL_FIX_PLAN.md):
 *  - `browser_inspect` returns real entries (report §3.2: it returned
 *    `undefined` because the page script never ran), with a UNIQUE selector per
 *    element — including duplicate ids, repeated siblings, and nested elements;
 *  - an index action acts on the inspected node itself, so an identical sibling
 *    inserted before it cannot capture the action;
 *  - hidden, disabled, and stale targets are refused;
 *  - an out-of-viewport coordinate is refused and never reaches the page
 *    (report §3.8), while an in-viewport one does.
 *
 * A `data:` URL is used so the origin-approval gate never fires (a data: URL has
 * no origin), keeping the loop deterministic. The screenshot lands in the real
 * `~/.forge/screenshots/<conv>/` path by design (plan §4.3).
 */
const PAGE =
  'data:text/html,' +
  encodeURIComponent(
    '<html><body style="font:28px sans-serif;padding:24px">' +
      '<h1 id="h">Before click</h1>' +
      '<button id="btn" onclick="document.getElementById(\'h\').textContent=\'After click\'">Click me</button>' +
      '</body></html>',
  );

/**
 * A fixture page with the shapes that break a naive selector: a duplicate `id`
 * used on three different elements, repeated identical siblings, a nested
 * target, a hidden button, a disabled button, and a text input. Every element
 * records its own click so an action can be attributed to a specific node.
 */
const RICH_HTML =
  '<html><body style="font:16px sans-serif;padding:16px">' +
  '<h1 id="h">idle</h1>' +
  // Three elements share id="dup": `#dup` is therefore ambiguous and must not be
  // used as an entry's selector.
  '<div id="dup">' +
  '<button data-who="original" onclick="document.getElementById(\'h\').textContent=\'ORIGINAL\'">Dup</button>' +
  '<button id="dup" onclick="document.getElementById(\'h\').textContent=\'SECOND\'">Second dup</button>' +
  '</div>' +
  // Nested target with a genuinely unique id.
  '<section><div><div><button id="nested" title="Nested target" onclick="document.getElementById(\'h\').textContent=\'NESTED\'">Go</button></div></div></section>' +
  '<a id="dup" href="#x">Link dup</a>' +
  '<input id="q" type="text" placeholder="Search">' +
  '<button id="hiddenBtn" style="display:none">Hidden</button>' +
  '<button id="disabledBtn" disabled>Disabled</button>' +
  '<button id="plain" onclick="document.getElementById(\'h\').textContent=\'PLAIN\'">Plain</button>' +
  '<div id="bg" style="width:200px;height:120px;background:#eee" onclick="window.__bg=(window.__bg||0)+1"></div>' +
  '<script>window.__clicks=[];document.addEventListener(\'click\',e=>{window.__clicks.push([e.clientX,e.clientY])});' +
  // A page timer that mutates the DOM without navigating: any index action must
  // survive (or refuse) against a document that is not the one inspected.
  'window.__mutate=()=>{const b=document.querySelector(\'#dup button\');if(b){b.textContent=\'Dup (mutated)\';}};' +
  '</script>' +
  '</body></html>';
const RICH_PAGE = 'data:text/html,' + encodeURIComponent(RICH_HTML);

const EMPTY_PAGE = 'data:text/html,' + encodeURIComponent('<html><body><p>Nothing here.</p></body></html>');

type HandlerCtx = Parameters<RegisteredTool['handler']>[1];
const toolCtx = { conversationId: 'browser-integration-test' } as unknown as HandlerCtx;

const getConfig = (): ForgeConfig =>
  ({
    active_model: 'primary',
    llama_server: {},
    models: [{ name: 'primary', gguf_path: '/primary.gguf' }],
    browser: { channel: 'chrome', headless: true },
  }) as ForgeConfig;

/** One shared session: the tests below are ordered and build on each other. */
const mgr = new BrowserSessionManager();
const ctx = buildBrowserToolContext(getConfig, mgr);
const tools = new Map<string, RegisteredTool>(
  [...makeBrowserSessionTools(ctx), ...makeBrowserActionTools(ctx)].map((t) => [
    t.definition.function.name,
    t,
  ]),
);

const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> =>
  tools.get(name)!.handler(args, toolCtx);

const callText = async (name: string, args: Record<string, unknown> = {}): Promise<string> =>
  (await call(name, args)) as string;

const pngFromShot = (shot: MultimodalToolResult): Buffer => {
  const img = shot.content!.find((p) => p.type === 'image_url') as { image_url: { url: string } };
  return Buffer.from(img.image_url.url.split('base64,')[1], 'base64');
};

/** Parse a `browser_inspect` text block into its entries. */
const parseInspect = (text: string): { index: number; role: string; text: string; selector: string }[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('['))
    .map((line) => {
      // The selector may contain spaces (`html > body:nth-of-type(1) > …`), so it
      // is everything between the em dash and the trailing bbox parenthesis.
      const m = line.match(/^\[(\d+)\]\s+(\S+)\s+"([^"]*)"\s+—\s+(.+?)\s+\([^)]*\)$/);
      if (!m) throw new Error(`unparsable inspect line: ${line}`);
      return { index: Number(m[1]), role: m[2], text: m[3], selector: m[4] };
    });

/** True when the browser can be launched on this host at all. */
let opened = false;
let skipReason = '';

const requireBrowser = (t: { skip(message?: string): void }): void => {
  if (!opened) t.skip(skipReason || 'no browser on this host');
};

describe('browser tools: inspect, index identity, coordinate bounds (Phase 1)', () => {
  afterAll(async () => {
    await mgr.close().catch(() => undefined);
  });

  it('drives headless Chrome through the screenshot → click → screenshot loop', async (t) => {
    let openRes: string;
    try {
      openRes = (await call('browser_open', { url: PAGE })) as string;
      opened = true;
    } catch (err) {
      skipReason = `browser_open failed (no Chrome on this host?): ${(err as Error).message}`;
      t.skip(skipReason);
      return;
    }
    expect(openRes).toMatch(/Browser ready/);

    // browser_screenshot #1 — assert the multimodal shape (inline image + text).
    const shot1 = (await call('browser_screenshot')) as MultimodalToolResult;
    expect(shot1.content).toBeDefined();
    expect(shot1.text).toMatch(/coord_space=image_px/);
    expect(shot1.text).toMatch(/Saved to /);
    const img1 = shot1.content!.find((p) => p.type === 'image_url') as {
      image_url: { url: string };
    };
    expect(img1.image_url.url).toMatch(/^data:image\/png;base64,/);

    // browser_click — a known element (the button that rewrites the heading).
    const clickRes = (await call('browser_click', { selector: '#btn' })) as string;
    expect(clickRes).toMatch(/clicked/);

    // browser_screenshot #2 — the visible state must have changed.
    const shot2 = (await call('browser_screenshot')) as MultimodalToolResult;
    expect(pngFromShot(shot1).equals(pngFromShot(shot2))).toBe(false);
  }, 60000);

  it('browser_inspect returns real entries with unique selectors', async (t) => {
    requireBrowser(t);
    await call('browser_navigate', { url: RICH_PAGE });
    const listed = parseInspect(await callText('browser_inspect'));

    // Regression for report §3.2: the handler used to throw
    // `Cannot read properties of undefined (reading 'length')` because
    // page.evaluate handed back `undefined`. A populated list proves the page
    // script actually ran.
    expect(listed.length).toBeGreaterThan(0);

    const byText = (label: string) => listed.find((e) => e.text === label);
    const byRoleText = (role: string, label: string) =>
      listed.find((e) => e.role === role && e.text === label);

    // Every selector must resolve to exactly one element, and to the element it
    // describes. A duplicate `id` must not become `#dup`.
    const resolve = (selector: string): Promise<{ n: number; who: string | null; title: string | null }> =>
      mgr.pageEvalForTest<{ n: number; who: string | null; title: string | null }>(
        (sel: string) => {
          const doc = globalThis.document as unknown as {
            querySelectorAll(s: string): { length: number; item(i: number): unknown };
          };
          const all = doc.querySelectorAll(sel);
          const first = all.item(0) as
            | { getAttribute(a: string): string | null; title?: string }
            | null;
          return {
            n: all.length,
            who: first ? first.getAttribute('data-who') : null,
            title: first ? (first.title ?? null) : null,
          };
        },
        selector,
      );

    for (const entry of listed) {
      const hit = await resolve(entry.selector);
      expect(hit.n, `selector ${entry.selector} matched ${hit.n} elements`).toBe(1);
    }

    // The ambiguous-id button is described by a full ancestry path, not `#dup`,
    // and that path still points at the original node.
    const dup = byText('Dup');
    expect(dup).toBeDefined();
    expect(dup!.selector).not.toBe('#dup');
    expect(dup!.selector).toContain('nth-of-type');
    expect((await resolve(dup!.selector)).who).toBe('original');

    // A unique id is still used, and a nested target is reachable. The label is
    // the `title` attribute, which outranks textContent in the label precedence.
    const nested = byRoleText('button', 'Nested target');
    expect(nested).toBeDefined();
    expect(nested!.selector).toBe('#nested');
    expect((await resolve('#nested')).title).toBe('Nested target');

    // Roles come from the tag/type mapping, and the input is listed.
    expect(byRoleText('link', 'Link dup')).toBeDefined();
    const input = listed.find((e) => e.role === 'text');
    expect(input).toBeDefined();
    expect(input!.text).toBe('Search'); // placeholder is the label when there is no text

    // bbox is viewport CSS px, finite and non-negative for an on-screen element.
    const plain = byText('Plain');
    expect(plain).toBeDefined();
  }, 60000);

  it('an index action acts on the inspected node, not an identical inserted sibling', async (t) => {
    requireBrowser(t);
    await call('browser_navigate', { url: RICH_PAGE });
    const listed = parseInspect(await callText('browser_inspect'));
    const dup = listed.find((e) => e.text === 'Dup')!;

    // Insert an IDENTICAL sibling (same tag, same text, same role) before the
    // inspected button. A selector-based identity check cannot tell them apart:
    // the `nth-of-type` path now resolves to the new node.
    await mgr.pageEvalForTest((label: string) => {
      const doc = globalThis.document as unknown as {
        querySelector(s: string): { parentElement: { insertBefore(n: unknown, c: unknown): void }; nextElementSibling: unknown } | null;
        createElement(t: string): { textContent: string; setAttribute(a: string, v: string): void; id: string; onclick: string };
      };
      const target = doc.querySelector('[data-who="original"]');
      if (!target) throw new Error('fixture missing the original button');
      const b = doc.createElement('button');
      b.textContent = label;
      b.setAttribute('data-who', 'sibling');
      b.id = 'injected';
      b.onclick = "document.getElementById('h').textContent='SIBLING'";
      target.parentElement!.insertBefore(b, target);
      return true;
    }, 'Dup');

    // Prove the selector alone would have hit the NEW node — the exact defect the
    // fix plan calls out ("inserting an identical sibling can shift the
    // selector to a different node").
    const who = await mgr.pageEvalForTest<string>(
      (sel: string) =>
        (
          globalThis.document as unknown as {
            querySelector(s: string): { getAttribute(a: string): string | null } | null;
          }
        ).querySelector(sel)?.getAttribute('data-who') ?? 'none',
      dup.selector,
    );
    expect(who).toBe('sibling');

    // The index action must still land on the ORIGINAL node.
    const res = await callText('browser_click', { index: dup.index });
    expect(res).toMatch(/clicked element/);
    const heading = await mgr.pageEvalForTest<string>(
      () => (globalThis.document as unknown as { getElementById(id: string): { textContent: string } }).getElementById('h').textContent,
    );
    expect(heading).toBe('ORIGINAL');
  }, 60000);

  it('refuses a hidden or disabled index target', async (t) => {
    requireBrowser(t);
    await call('browser_navigate', { url: RICH_PAGE });
    const listed = parseInspect(await callText('browser_inspect'));

    const hidden = listed.find((e) => e.text === 'Hidden')!;
    expect(hidden).toBeDefined();
    await expect(call('browser_click', { index: hidden.index })).rejects.toThrow(
      /not visible|no longer in the document/,
    );

    const disabled = listed.find((e) => e.text === 'Disabled')!;
    expect(disabled).toBeDefined();
    await expect(call('browser_click', { index: disabled.index })).rejects.toThrow(/disabled/);

    // And a non-editable target is refused by browser_type with a named reason.
    await expect(call('browser_type', { index: listed.find((e) => e.text === 'Plain')!.index, text: 'x' })).rejects.toThrow(
      /is not editable/,
    );
    // The text input accepts the same call shape.
    const input = listed.find((e) => e.role === 'text')!;
    const typed = await callText('browser_type', { index: input.index, text: 'café 🚀你好' });
    expect(typed).toMatch(/typed into element/);
    const value = await mgr.pageEvalForTest<string>(
      () => (globalThis.document as unknown as { getElementById(id: string): { value: string } }).getElementById('q').value,
    );
    expect(value).toBe('café 🚀你好');
  }, 60000);

  it('refuses a stale index after the tab navigates, and after a DOM mutation', async (t) => {
    requireBrowser(t);
    await call('browser_navigate', { url: RICH_PAGE });
    const listed = parseInspect(await callText('browser_inspect'));
    const dup = listed.find((e) => e.text === 'Dup')!;

    // A page script mutates the label without navigating. The snapshot still
    // exists, so the mandatory recheck is what must catch this.
    await mgr.pageEvalForTest(() => {
      (globalThis as unknown as { __mutate(): void }).__mutate();
      return true;
    });
    await expect(call('browser_click', { index: dup.index })).rejects.toThrow(/changed/);

    // Navigation to a different document drops the snapshot outright.
    await call('browser_navigate', { url: PAGE });
    await expect(call('browser_click', { index: dup.index })).rejects.toThrow(
      /no inspection|stale/,
    );

    // And an index never inspected at all is refused, not guessed.
    await expect(call('browser_click', { index: 99 })).rejects.toThrow(
      /no element at index 99|no inspection/,
    );
  }, 60000);

  it('an empty page inspects to a clean empty result', async (t) => {
    requireBrowser(t);
    await call('browser_navigate', { url: EMPTY_PAGE });
    expect(await callText('browser_inspect')).toBe('No interactive elements found on this page.');
  }, 60000);

  it('refuses an out-of-viewport coordinate without ever firing a page click', async (t) => {
    requireBrowser(t);
    await call('browser_navigate', { url: RICH_PAGE });

    for (const bad of [
      { x: 5000, y: 5000 },
      { x: 1280, y: 10 }, // one pixel past the right edge
      { x: 10, y: 800 }, // one pixel past the bottom edge
      { x: -1, y: 10 },
      { x: Number.NaN, y: 10 },
    ]) {
      await expect(call('browser_click', bad)).rejects.toThrow(/outside the .* viewport/);
    }
    // The refusal must name the point and the viewport, so the caller can fix it.
    await expect(call('browser_click', { x: 5000, y: 5000 })).rejects.toThrow(/5000,5000.*1280×800/);

    const fired = await mgr.pageEvalForTest<number>(
      () => (globalThis as unknown as { __clicks?: unknown[] }).__clicks?.length ?? 0,
    );
    expect(fired).toBe(0);

    // An in-bounds point DOES reach the page — the guard did not break the path.
    const box = await mgr.pageEvalForTest<{ x: number; y: number }>(
      () => {
        const el = (globalThis.document as unknown as { getElementById(id: string): HTMLElement }).getElementById('bg');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      },
    );
    const ok = await callText('browser_click', box);
    expect(ok).toMatch(/clicked at/);
    const after = await mgr.pageEvalForTest<number>(
      () => (globalThis as unknown as { __bg?: number }).__bg ?? 0,
    );
    expect(after).toBe(1);

    // Hover shares the same bound.
    await expect(call('browser_hover', { x: 4000, y: 4000 })).rejects.toThrow(
      /outside the .* viewport/,
    );
  }, 60000);

  it('closes the session', async (t) => {
    requireBrowser(t);
    expect(await callText('browser_close')).toMatch(/Browser closed/);
  }, 30000);
});
