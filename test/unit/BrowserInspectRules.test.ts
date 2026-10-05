/**
 * Unit tests for the pure rules behind `browser_inspect` and index actions
 * (docs/plans/DESKTOP_BROWSER_TOOL_FIX_PLAN.md Phase 1). These are the decisions
 * that turn the page callback's raw facts into a label, a fillability answer, or
 * an index refusal — testable with no browser, which is the point of keeping the
 * page callbacks fact-only.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSPECT_MAX,
  MAX_INSPECT_ELEMENTS,
  clampInspectMax,
  fillableFromFacts,
  roleFromFacts,
  textFromFacts,
  verdictForRecheck,
  type ElementFacts,
  type NodeRecheck,
  type RecheckExpected,
} from '../../src/tools/browser/browserInspect';

/** A plain visible button's facts. */
const facts = (over: Partial<ElementFacts> = {}): ElementFacts => ({
  role: null,
  tag: 'button',
  type: null,
  ariaLabel: null,
  title: null,
  textContent: 'Click me',
  placeholder: null,
  value: null,
  contentEditable: null,
  readOnly: false,
  disabled: false,
  ...over,
});

const expected = (over: Partial<RecheckExpected> = {}): RecheckExpected => ({
  role: 'button',
  text: 'Click me',
  tag: 'button',
  action: 'click',
  index: 3,
  ...over,
});

const live = (over: Partial<NodeRecheck> = {}): NodeRecheck => ({
  attached: true,
  visible: true,
  facts: facts(),
  ...over,
});

describe('clampInspectMax', () => {
  it('defaults for anything that is not a usable number', () => {
    for (const bad of [undefined, null, NaN, Infinity, -Infinity, 0, -5, '50', true]) {
      expect(clampInspectMax(bad)).toBe(DEFAULT_INSPECT_MAX);
    }
  });

  it('honours an explicit value and clamps it to the documented ceiling', () => {
    expect(clampInspectMax(1)).toBe(1);
    expect(clampInspectMax(250)).toBe(250);
    expect(clampInspectMax(MAX_INSPECT_ELEMENTS)).toBe(MAX_INSPECT_ELEMENTS);
    expect(clampInspectMax(1_000_000)).toBe(MAX_INSPECT_ELEMENTS);
    expect(clampInspectMax(12.9)).toBe(12);
  });
});

describe('roleFromFacts', () => {
  it('prefers the declared role attribute', () => {
    expect(roleFromFacts(facts({ role: 'link' }))).toBe('link');
    expect(roleFromFacts(facts({ tag: 'div', role: 'button' }))).toBe('button');
  });

  it('maps a[href] and input by tag, and lowercases other tags', () => {
    expect(roleFromFacts(facts({ tag: 'a' }))).toBe('link');
    expect(roleFromFacts(facts({ tag: 'input', type: 'checkbox' }))).toBe('checkbox');
    // An INPUT with no type attribute defaults to "text" per the HTML spec.
    expect(roleFromFacts(facts({ tag: 'input', type: null }))).toBe('input');
    // `tag` arrives lowercased: the page callback normalizes it (verified live in
    // test/integration/BrowserTools.test.ts), so the rule here stays a lookup.
    expect(roleFromFacts(facts({ tag: 'summary' }))).toBe('summary');
  });
});

describe('textFromFacts', () => {
  it('follows aria-label, title, text, placeholder, value', () => {
    expect(textFromFacts(facts({ ariaLabel: 'A', title: 'T', textContent: 'X' }))).toBe('A');
    expect(textFromFacts(facts({ title: 'T', textContent: 'X' }))).toBe('T');
    expect(textFromFacts(facts({ textContent: 'X', placeholder: 'P', value: 'V' }))).toBe('X');
    expect(textFromFacts(facts({ textContent: null, placeholder: 'P', value: 'V' }))).toBe('P');
    expect(textFromFacts(facts({ textContent: null, value: 'V' }))).toBe('V');
    expect(textFromFacts(facts({ textContent: null }))).toBe('');
  });

  it('falls past an EMPTY textContent — the input/select/img case', () => {
    // `<input>`/`<select>` report textContent === '' (not null), so a strict
    // `??` chain would label every empty text field "" and hide its placeholder.
    expect(
      textFromFacts(facts({ tag: 'input', type: 'text', textContent: '', placeholder: 'Search' })),
    ).toBe('Search');
    expect(textFromFacts(facts({ tag: 'input', type: 'submit', textContent: '', value: 'Send' }))).toBe(
      'Send',
    );
    // Whitespace-only text is not a label either.
    expect(textFromFacts(facts({ textContent: '   ', ariaLabel: 'Real' }))).toBe('Real');
  });

  it('trims and caps at 80 characters', () => {
    expect(textFromFacts(facts({ textContent: '  padded  ' }))).toBe('padded');
    expect(textFromFacts(facts({ textContent: 'x'.repeat(200) })).length).toBe(80);
  });

  it('mirrors the page-side trim so a stored label and a live one compare equal', () => {
    // The page callback may hand back untrimmed textContent; the derived label
    // must not differ between inspect and recheck purely because of that.
    const stored = textFromFacts(facts({ textContent: ' Save ' }));
    const liveLabel = textFromFacts(facts({ textContent: ' Save ' }));
    expect(stored).toBe(liveLabel);
    expect(stored).toBe('Save');
  });
});

describe('fillableFromFacts', () => {
  it('accepts text-like inputs, textareas, selects, and contenteditable', () => {
    expect(fillableFromFacts(facts({ tag: 'input', type: 'text' }))).toBe(true);
    expect(fillableFromFacts(facts({ tag: 'input', type: null }))).toBe(true);
    expect(fillableFromFacts(facts({ tag: 'input', type: 'SEARCH' }))).toBe(true);
    expect(fillableFromFacts(facts({ tag: 'textarea' }))).toBe(true);
    expect(fillableFromFacts(facts({ tag: 'select' }))).toBe(true);
    expect(fillableFromFacts(facts({ tag: 'div', contentEditable: 'true' }))).toBe(true);
    // An empty contenteditable attribute is valid HTML for "true".
    expect(fillableFromFacts(facts({ tag: 'div', contentEditable: '' }))).toBe(true);
  });

  it('refuses buttons, non-text inputs, readonly fields, and disabled fields', () => {
    expect(fillableFromFacts(facts())).toBe(false);
    for (const type of ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'color', 'range']) {
      expect(fillableFromFacts(facts({ tag: 'input', type }))).toBe(false);
    }
    expect(fillableFromFacts(facts({ tag: 'input', type: 'text', readOnly: true }))).toBe(false);
    expect(fillableFromFacts(facts({ tag: 'textarea', readOnly: true }))).toBe(false);
    expect(fillableFromFacts(facts({ tag: 'div', contentEditable: 'false' }))).toBe(false);
    expect(fillableFromFacts(facts({ tag: 'input', type: 'text', disabled: true }))).toBe(false);
  });
});

describe('verdictForRecheck', () => {
  it('accepts the same live node and reports its fillability', () => {
    const v = verdictForRecheck(live(), expected());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.editable).toBe(false);
    const fill = verdictForRecheck(
      live({ facts: facts({ tag: 'input', type: 'text', textContent: 'Click me' }) }),
      expected({ role: 'text' }),
    );
    expect(fill.ok).toBe(true);
    if (fill.ok) expect(fill.editable).toBe(true);
  });

  it('refuses a detached node', () => {
    const v = verdictForRecheck({ attached: false }, expected());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/no longer in the document/);
  });

  it('refuses an unreadable recheck rather than acting blind', () => {
    const v = verdictForRecheck({ attached: true, visible: true }, expected());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/could not re-read/);
  });

  it('refuses a node whose role or text changed', () => {
    const changed = verdictForRecheck(live({ facts: facts({ textContent: 'Deleting…' }) }), expected());
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.message).toMatch(/changed/);
      expect(changed.message).toMatch(/Click me/);
      expect(changed.message).toMatch(/Deleting…/);
    }
    const retagged = verdictForRecheck(
      live({ facts: facts({ tag: 'a', role: 'link', type: null }) }),
      expected(),
    );
    expect(retagged.ok).toBe(false);
  });

  it('refuses a disabled or hidden/covered node', () => {
    const disabled = verdictForRecheck(live({ facts: facts({ disabled: true }) }), expected());
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.message).toMatch(/disabled/);

    for (const hidden of [false, undefined]) {
      const v = verdictForRecheck(live({ visible: hidden }), expected());
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.message).toMatch(/not visible or is covered/);
    }
  });

  it('names the tool and index in every refusal', () => {
    for (const v of [
      verdictForRecheck({ attached: false }, expected({ action: 'type', index: 0 })),
      verdictForRecheck(live({ visible: false }), expected({ action: 'hover', index: 7 })),
    ]) {
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.message).toContain('call browser_inspect again');
    }
    const t = verdictForRecheck({ attached: false }, expected({ action: 'type', index: 0 }));
    if (!t.ok) expect(t.message).toMatch(/^browser_type: the element at index 0/);
    const h = verdictForRecheck(live({ visible: false }), expected({ action: 'hover', index: 7 }));
    if (!h.ok) expect(h.message).toMatch(/^browser_hover: the element at index 7/);
  });
});
