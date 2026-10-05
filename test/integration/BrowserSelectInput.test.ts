import { afterAll, describe, expect, it } from 'vitest';
import { RICH_PAGE, SELECT_PAGE, createBrowserHarness } from '../support/browserHarness';

/**
 * `browser_type` against a real `<select>`, in headless Chrome.
 *
 * Regression from the 2026-10-06 live smoke: a dropdown passed the editability
 * guard — whose own message lists "select" as typable — and then died 5 seconds
 * later inside Playwright's `fill` with "Element is not an <input>, <textarea>
 * or [contenteditable] element". A `<select>` has to be chosen into, not filled.
 *
 * Split out from `BrowserTools.test.ts` (which owns inspect/identity/coordinate
 * gates) and past the 500-line lint limit; both files use the one harness in
 * `test/support/browserHarness.ts`. The pure half of this behaviour — matching,
 * the shared time budget, the refusal text — is unit-tested in
 * `test/unit/BrowserSelectInput.test.ts`; this file proves the same paths against
 * a real DOM, including what the control actually ends up holding.
 */
const h = createBrowserHarness('browser-select-input-test');
const { mgr, call, callText, parseInspect, requireBrowser } = h;

describe('browser_type on a <select> (dropdown input)', () => {
  afterAll(async () => {
    await h.close();
  });

  it('opens the session', async (t) => {
    let openRes: string;
    try {
      openRes = (await h.callText('browser_open', { url: SELECT_PAGE })) as string;
      h.opened = true;
    } catch (err) {
      h.skipReason = `browser_open failed (no Chrome on this host?): ${(err as Error).message}`;
      t.skip(h.skipReason);
      return;
    }
    expect(openRes).toMatch(/Browser ready/);
  }, 60000);

  /** The current `value` of one control, read straight off the DOM. */
  const valueOf = (id: string): Promise<string> =>
    mgr.pageEvalForTest<string, string>((controlId: string) => {
      const el = (
        globalThis.document as unknown as { getElementById(id: string): { value: string } | null }
      ).getElementById(controlId);
      return el ? el.value : '<missing>';
    }, id);

  it('chooses an option by exact label, then by exact value', async (t) => {
    requireBrowser(t);
    const listed = parseInspect(await callText('browser_inspect'));
    const sel = listed.find((e) => e.selector === '#s');
    expect(sel, 'browser_inspect must list the dropdown').toBeDefined();

    const byLabel = await callText('browser_type', { index: sel!.index, text: 'Two' });
    // The label and value differ here, so the result names both — a caller
    // confirming a choice needs to see which of the two it matched.
    expect(byLabel).toMatch(/selected "Two" \(value: 2\) in element/);
    expect(await valueOf('s')).toBe('2');

    const byValue = await callText('browser_type', { index: sel!.index, text: '3' });
    expect(byValue).toMatch(/selected "Three" \(value: 3\)/);
    expect(await valueOf('s')).toBe('3');
  }, 60000);

  it('refuses a choice the dropdown does not offer, and lists what it does', async (t) => {
    requireBrowser(t);
    await call('browser_navigate', { url: SELECT_PAGE });
    const listed = parseInspect(await callText('browser_inspect'));
    const sel = listed.find((e) => e.selector === '#s')!;

    // The options are read BEFORE selecting, so this is an instant refusal that
    // names the real choices — not a 5 s Playwright timeout whose wording the
    // caller cannot act on.
    const at = Date.now();
    await expect(call('browser_type', { index: sel.index, text: 'Purple' })).rejects.toThrow(
      /is a dropdown and "Purple" matches no option[\s\S]*Its options are: One \(value: 1\), Two \(value: 2\), Three \(value: 3\)/,
    );
    expect(Date.now() - at).toBeLessThan(5000);

    // A refusal must not change the control: it still holds the last real choice.
    await callText('browser_type', { index: sel.index, text: 'Three' });
    await expect(call('browser_type', { index: sel.index, text: 'Purple' })).rejects.toThrow(
      /matches no option/,
    );
    expect(await valueOf('s')).toBe('3');

    // No fuzzy matching: a substring would silently pick the wrong option.
    for (const nearMiss of ['wo', 'TWO', 'Two ']) {
      await expect(call('browser_type', { index: sel.index, text: nearMiss })).rejects.toThrow(
        /matches no option/,
      );
    }
    expect(await valueOf('s')).toBe('3');
  }, 60000);

  it('takes the same branch when the dropdown is addressed by selector', async (t) => {
    requireBrowser(t);
    await call('browser_navigate', { url: SELECT_PAGE });
    // The snapshot machinery is index-only, so the selector path used to reach
    // `fill` regardless of tag. It must select too.
    const viaSelector = await callText('browser_type', { selector: '#s', text: 'One' });
    expect(viaSelector).toMatch(/selected "One" \(value: 1\) in "#s"/);
    expect(await valueOf('s')).toBe('1');

    // And its refusal keeps the selector form of the naming.
    await expect(call('browser_type', { selector: '#s', text: 'Purple' })).rejects.toThrow(
      /browser_type: element "#s" is a dropdown and "Purple" matches no option/,
    );
  }, 60000);

  it('chooses into a multi-select and says what it did', async (t) => {
    requireBrowser(t);
    await call('browser_navigate', { url: SELECT_PAGE });
    const listed = parseInspect(await callText('browser_inspect'));
    const multi = listed.find((e) => e.selector === '#m');
    expect(multi, 'browser_inspect must list the multi-select').toBeDefined();

    const res = await callText('browser_type', { index: multi!.index, text: 'B' });
    expect(res).toMatch(/selected "B"/);
    expect(res).toMatch(/multi-select/);
    const selected = await mgr.pageEvalForTest<string[]>(() => {
      const el = (
        globalThis.document as unknown as {
          getElementById(id: string): { selectedOptions: { length: number; item(i: number): { value: string } | null } };
        }
      ).getElementById('m');
      const out: string[] = [];
      for (let i = 0; i < el.selectedOptions.length; i++) {
        out.push(el.selectedOptions.item(i)?.value ?? '');
      }
      return out;
    });
    expect(selected).toEqual(['b']);
  }, 60000);

  it('leaves the fill path and the non-editable refusal untouched', async (t) => {
    requireBrowser(t);
    // The new branch must not disturb the two paths that already worked: a real
    // text input still fills, and a button still gets the named refusal.
    await call('browser_navigate', { url: RICH_PAGE });
    const rich = parseInspect(await callText('browser_inspect'));
    await expect(
      call('browser_type', { index: rich.find((e) => e.text === 'Plain')!.index, text: 'x' }),
    ).rejects.toThrow(/is not editable/);
    const typed = await callText('browser_type', {
      index: rich.find((e) => e.role === 'text')!.index,
      text: 'still fills',
    });
    expect(typed).toMatch(/typed into element/);
    expect(await valueOf('q')).toBe('still fills');

    // A selector-addressed text input keeps its original success wording.
    expect(await callText('browser_type', { selector: '#q', text: 'by selector' })).toMatch(
      /^typed into "#q"$/,
    );
    expect(await valueOf('q')).toBe('by selector');
  }, 60000);
});
