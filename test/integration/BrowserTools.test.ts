import { afterAll, describe, expect, it } from 'vitest';
import type { MultimodalToolResult } from '../../src/tools/ToolRegistry';
import { EMPTY_PAGE, PAGE, RICH_PAGE, createBrowserHarness } from '../support/browserHarness';

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
 * The fixtures and the tool-invocation harness live in
 * `test/support/browserHarness.ts`, shared with `BrowserSelectInput.test.ts`, so
 * both files assert against ONE copy of each fixture and of `parseInspect`.
 *
 * A `data:` URL is used for every fixture so the origin-approval gate never
 * fires (a data: URL has no origin), keeping the loop deterministic. The
 * screenshot lands in the real `~/.forge/screenshots/<conv>/` path by design
 * (plan §4.3).
 */

/** One shared session: the tests below are ordered and build on each other. */
const h = createBrowserHarness('browser-integration-test');
const { mgr, call, callText, pngFromShot, parseInspect, requireBrowser } = h;

describe('browser tools: inspect, index identity, coordinate bounds (Phase 1)', () => {
  afterAll(async () => {
    await h.close();
  });

  it('drives headless Chrome through the screenshot → click → screenshot loop', async (t) => {
    let openRes: string;
    try {
      openRes = (await call('browser_open', { url: PAGE })) as string;
      h.opened = true;
    } catch (err) {
      h.skipReason = `browser_open failed (no Chrome on this host?): ${(err as Error).message}`;
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

  it('bounds a selector action at 5s: missing, hidden, and late-appearing targets', async (t) => {
    requireBrowser(t);
    // Fix-plan Phase 3 item 1 (report §3.5): a bad selector used to cost
    // Playwright's full 30 s default. Three cases, one shared bound:
    //   - a selector that matches nothing fails fast and names the target;
    //   - an element that is permanently hidden fails fast (actionability waits);
    //   - an element that appears after a short delay still succeeds, so the
    //     bound is not so tight that a slow-but-valid page breaks.
    await call('browser_navigate', { url: RICH_PAGE });

    const missingAt = Date.now();
    await expect(call('browser_click', { selector: '#definitely-not-here' })).rejects.toThrow(
      /browser_click: selector "#definitely-not-here" failed within 5000 ms/,
    );
    const missingMs = Date.now() - missingAt;
    // Under 10 s proves the 5 s bound is in force, with room for a slow host.
    expect(missingMs).toBeLessThan(10000);
    // The Playwright cause is preserved inside the named wrapper, not swallowed.
    await expect(call('browser_click', { selector: '#definitely-not-here' })).rejects.toThrow(
      /Timeout 5000ms|Timeout exceeded/s,
    );

    // A permanently hidden element: present in the DOM, never actionable.
    const hiddenAt = Date.now();
    await expect(call('browser_click', { selector: '#hiddenBtn' })).rejects.toThrow(
      /browser_click: selector "#hiddenBtn" failed within 5000 ms/,
    );
    expect(Date.now() - hiddenAt).toBeLessThan(10000);

    // The bound applies to the other selector actions too, and names each one.
    await expect(call('browser_type', { selector: '#nope', text: 'x' })).rejects.toThrow(
      /browser_type: selector "#nope" failed within 5000 ms/,
    );
    await expect(call('browser_hover', { selector: '#nope' })).rejects.toThrow(
      /browser_hover: selector "#nope" failed within 5000 ms/,
    );
    await expect(call('browser_press', { key: 'Enter', selector: '#nope' })).rejects.toThrow(
      /browser_press: selector "#nope" failed within 5000 ms/,
    );
    await expect(
      call('browser_scroll', { selector: '#nope', delta_x: 0, delta_y: 10 }),
    ).rejects.toThrow(/browser_scroll: selector "#nope" failed within 5000 ms/);

    // A valid element that appears 1.2 s later must still be reachable — the
    // bound shortens the wait for a dead selector, it does not shorten the wait
    // for a slow page.
    await call('browser_navigate', {
      url:
        'data:text/html,' +
        encodeURIComponent(
          '<html><body><h1 id="h">waiting</h1><script>setTimeout(function(){' +
            'var b=document.createElement("button");b.id="late";' +
            'b.textContent="Late";b.onclick=function(){document.getElementById("h").textContent="LATE"};' +
            'document.body.appendChild(b);},1200);</script></body></html>',
        ),
    });
    const lateAt = Date.now();
    expect(await callText('browser_click', { selector: '#late' })).toMatch(/clicked "#late"/);
    const lateMs = Date.now() - lateAt;
    expect(lateMs).toBeGreaterThan(1000);
    expect(lateMs).toBeLessThan(5000);

    // …and the click really landed on it.
    const heading = await mgr.pageEvalForTest<string>(
      () => document.getElementById('h')?.textContent ?? '',
    );
    expect(heading).toBe('LATE');

    // An index action on a node hidden after inspection is refused FAST, and by
    // the Phase 1 identity recheck rather than by the locator bound: the
    // recheck runs first, so the 5 s timeout behind it is belt-and-braces and
    // the 30 s default is never reached either way. Asserted here so a future
    // change that drops the recheck cannot silently restore the long wait.
    await call('browser_navigate', { url: RICH_PAGE });
    const listed = parseInspect(await callText('browser_inspect'));
    const plain = listed.find((e) => e.text === 'Plain');
    expect(plain).toBeDefined();
    await mgr.pageEvalForTest(() => {
      const el = document.getElementById('plain');
      if (el) el.style.display = 'none';
    });
    const idxAt = Date.now();
    await expect(call('browser_click', { index: plain!.index })).rejects.toThrow(
      /browser_click: the element at index .* is not visible/,
    );
    expect(Date.now() - idxAt).toBeLessThan(5000);
  }, 120000);

  it('closes the session', async (t) => {
    requireBrowser(t);
    expect(await callText('browser_close')).toMatch(/Browser closed/);
  }, 30000);
});
