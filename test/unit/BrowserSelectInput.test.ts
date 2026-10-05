/**
 * Unit tests for the `<select>` decision rules behind `browser_type`
 * (docs/plans/DESKTOP_BROWSER_TOOL_FIX_PLAN.md — the dropdown regression found
 * in the 2026-10-06 live smoke).
 *
 * No browser here on purpose: the matching rule, the option reader, the shared
 * action budget, and the refusal text are all pure, so the whole failure surface
 * — no match, ambiguous label, multi-select, huge option list, spent budget — is
 * testable without launching Chrome. The integration file covers the same paths
 * against a real dropdown.
 */
import { describe, expect, it } from 'vitest';
import { matchOption, readSelectState } from '../../src/tools/browser/browserTextInput';
import {
  LOCATOR_ACTION_TIMEOUT_MS,
  MAX_LISTED_OPTIONS,
  remainingActionTimeout,
  selectOptionRefusal,
} from '../../src/tools/browser/browserActionGuards';

/** Build a page-shaped `<select>` stand-in for `readSelectState`. */
const pageSelect = (
  entries: { label: string; value?: string }[],
  over: { multiple?: boolean; selectedIndex?: number } = {},
): unknown => ({
  multiple: over.multiple === true,
  selectedIndex: over.selectedIndex ?? 0,
  options: {
    length: entries.length,
    item: (i: number) =>
      entries[i] === undefined
        ? null
        : { text: entries[i].label, value: entries[i].value ?? entries[i].label },
  },
});

describe('readSelectState', () => {
  it('reports each option with its position, value, and label', () => {
    const state = readSelectState(
      pageSelect([
        { label: 'One', value: '1' },
        { label: 'Two', value: '2' },
      ]),
    );
    expect(state.multiple).toBe(false);
    expect(state.selectedIndex).toBe(0);
    expect(state.options).toEqual([
      { index: 0, value: '1', label: 'One' },
      { index: 1, value: '2', label: 'Two' },
    ]);
  });

  it('falls back to the label as the value, as the DOM does', () => {
    // An `<option>` with no value attribute reports value === its text.
    const state = readSelectState(pageSelect([{ label: 'Plain' }]));
    expect(state.options[0]).toEqual({ index: 0, value: 'Plain', label: 'Plain' });
  });

  it('tolerates a non-select or an option-less select without throwing', () => {
    expect(readSelectState(null)).toEqual({ multiple: false, options: [], selectedIndex: -1 });
    expect(readSelectState({})).toEqual({ multiple: false, options: [], selectedIndex: -1 });
    const empty = readSelectState(pageSelect([]));
    expect(empty.options).toEqual([]);
    expect(empty.selectedIndex).toBe(0);
  });

  it('caps the transported option list so a huge select cannot blow up the result', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ label: `opt ${i}` }));
    const state = readSelectState(pageSelect(many));
    expect(state.options.length).toBe(200);
    // Positions stay true to the real collection: index 0 is still option 0.
    expect(state.options[0].index).toBe(0);
    expect(state.options[199].index).toBe(199);
  });
});

describe('matchOption', () => {
  const options = readSelectState(
    pageSelect([
      { label: 'Red', value: 'r' },
      { label: 'Blue', value: 'b' },
      { label: '', value: 'empty' },
    ]),
  ).options;

  it('matches an exact visible label', () => {
    const m = matchOption(options, 'Blue');
    expect(m).not.toBeNull();
    expect(m!.chosen.index).toBe(1);
    expect(m!.ambiguous).toBe(1);
  });

  it('matches an exact value when no label matches', () => {
    const m = matchOption(options, 'r');
    expect(m!.chosen.label).toBe('Red');
  });

  it('prefers a label match over a coincidental value match', () => {
    const mixed = readSelectState(
      pageSelect([
        { label: 'Alpha', value: 'x' },
        { label: 'x', value: 'zzz' },
      ]),
    ).options;
    const m = matchOption(mixed, 'x');
    expect(m!.chosen.label).toBe('x');
    expect(m!.chosen.index).toBe(1);
  });

  it('refuses anything that is not an exact match — no substring, no case-fold', () => {
    // A fuzzy match would let `type "l"` silently pick "Blue": a
    // plausible-looking success on the wrong option. (`Red` is deliberately NOT
    // here — it is an exact label of this fixture, so matching it is correct.)
    for (const bad of ['lu', 'BLUE', 'Blue ', 'red', '  ', 'OneTwo']) {
      expect(matchOption(options, bad), `matched ${JSON.stringify(bad)}`).toBeNull();
    }
    expect(matchOption([], 'anything')).toBeNull();
  });

  it('counts duplicate labels so the caller can say it took the first', () => {
    const dupes = readSelectState(
      pageSelect([
        { label: 'Same' },
        { label: 'Same' },
      ]),
    ).options;
    const m = matchOption(dupes, 'Same');
    expect(m!.chosen.index).toBe(0);
    expect(m!.ambiguous).toBe(2);
  });
});

describe('remainingActionTimeout (one budget, not two)', () => {
  it('hands the next attempt only what is left of the action bound', () => {
    const deadline = 10_000;
    expect(remainingActionTimeout(deadline, 9_000)).toBe(1_000);
    expect(remainingActionTimeout(deadline, 5_000)).toBe(5_000);
  });

  it('returns null once the budget is spent, so no third attempt starts', () => {
    expect(remainingActionTimeout(10_000, 10_000)).toBeNull();
    expect(remainingActionTimeout(10_000, 10_001)).toBeNull();
  });

  it('never lets a two-call dropdown exceed the documented bound', () => {
    // Reading options + selecting must share LOCATOR_ACTION_TIMEOUT_MS. If a
    // future change gave each call the full bound, a dropdown would cost 10 s
    // while the docs promise 5 — this pins the arithmetic that prevents it.
    const deadline = Date.now() + LOCATOR_ACTION_TIMEOUT_MS;
    const first = 1_500;
    const second = remainingActionTimeout(deadline, Date.now() + first);
    expect(second).not.toBeNull();
    expect(first + (second as number)).toBeLessThanOrEqual(LOCATOR_ACTION_TIMEOUT_MS);
  });
});

describe('selectOptionRefusal', () => {
  const options = readSelectState(
    pageSelect([
      { label: 'Red', value: 'r' },
      { label: 'Blue' },
    ]),
  ).options;

  it('names the tool, the element, and the text that failed', () => {
    const msg = selectOptionRefusal('4 ("OneTwo")', 'Purple', options, null);
    expect(msg).toMatch(/^browser_type: element 4 \("OneTwo"\) is a dropdown/);
    expect(msg).toMatch(/"Purple" matches no option/);
  });

  it('lists the real options, showing a value only when it differs from the label', () => {
    const msg = selectOptionRefusal('4', 'Purple', options, null);
    expect(msg).toContain('Red (value: r)');
    expect(msg).toContain('Blue');
    expect(msg).not.toContain('Blue (value: Blue)');
    expect(msg).toContain('Type an option');
  });

  it('says so plainly when the select has no options at all', () => {
    expect(selectOptionRefusal('4', 'x', [], null)).toContain('no options at all');
  });

  it('truncates a long option list rather than dumping the whole thing', () => {
    const many = Array.from({ length: MAX_LISTED_OPTIONS + 5 }, (_, i) => ({ label: `o${i}` }));
    const opts = readSelectState(pageSelect(many)).options;
    const msg = selectOptionRefusal('4', 'nope', opts, null);
    expect(msg).toContain(`+${opts.length - MAX_LISTED_OPTIONS} more`);
    expect(msg).toContain('o0');
    expect(msg).not.toContain('o16');
  });

  it('quotes a Playwright cause when one exists, and omits it when there is none', () => {
    // The read-options path refuses before Playwright is ever called, so quoting
    // `null` there would be noise.
    expect(selectOptionRefusal('4', 'x', options, null)).not.toContain('Playwright');
    expect(selectOptionRefusal('4', 'x', options, new Error('boom'))).toContain('(Playwright: boom)');
  });
});
