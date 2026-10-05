/**
 * Putting text into an inspected node — the one place that decides *how*.
 *
 * `browser_type` has two ways to set a node's value and Playwright's `fill`
 * implements only one of them. A `<select>` is editable in every human sense —
 * it has a value you can set — but `fill` refuses it outright. The editability
 * rule used to count a `<select>` as fillable, so the guard waved a dropdown
 * through and the call then died 5 seconds later inside Playwright with its own
 * wording ("Element is not an <input>, <textarea> or [contenteditable]
 * element"), while the refusal three lines earlier had claimed the opposite.
 *
 * This module owns that branch. `browserInspect.inputModeFor` decides the mode
 * once (fill / select / none) and the index recheck carries it here, so no
 * second copy of the rule exists to drift. `BrowserSessionManager` remains the
 * sole owner of sessions, tabs, and inspection snapshots: this file receives an
 * already-resolved, already-rechecked target and performs one action on it.
 *
 * The dropdown path reads the options BEFORE selecting anything. That makes a
 * bad choice an instant, honest refusal that lists what was actually available,
 * instead of spending the 5-second bound inside a Playwright attempt whose error
 * the model cannot act on. It also avoids Playwright's plain-string form, where
 * `selectOption('2')` can mean value `'2'` or index 2: selecting by the option's
 * own position in the `options` collection is unambiguous, and the result is
 * read back rather than assumed.
 *
 * Both target shapes (a retained `ElementHandle` from an index action, and a
 * `Locator` from a selector action) run through one flow via the two adapters at
 * the bottom, so the matching rule, the refusal text, and the read-back check
 * exist exactly once.
 */
import type { Locator } from 'playwright-core';
import type { IndexTarget } from './browserInspect';
import {
  LOCATOR_ACTION_TIMEOUT_MS,
  remainingActionTimeout,
  selectOptionRefusal,
  withLocatorActionTimeout,
} from './browserActionGuards';

/** One `<option>` plus its position in the select's `options` collection. */
interface PageOption {
  index: number;
  value: string;
  label: string;
}

/** What a `<select>` reports: its options and which one stands selected. */
interface SelectState {
  multiple: boolean;
  options: PageOption[];
  selectedIndex: number;
}

/**
 * Page callback: read a `<select>`'s options and current selection.
 *
 * Reports FACTS only — the matching rule and the refusal text live in TypeScript
 * below, so each has exactly one implementation. `selectedIndex` is the position
 * in `options`, which is also what `selectOption({ index })` means, so the
 * number read here and the number used to choose are the same number.
 */
export function readSelectState(target: unknown): SelectState {
  const sel = target as {
    multiple?: boolean;
    selectedIndex?: number;
    options?: { length: number; item(i: number): { text?: string; value?: string } | null };
  };
  const opts = sel && sel.options ? sel.options : null;
  const options: PageOption[] = [];
  // Bounded transport: a refusal lists the first MAX_LISTED_OPTIONS, and a
  // choice past this cap is refused by name rather than silently ignored.
  const cap = 200;
  if (opts) {
    for (let i = 0; i < opts.length; i++) {
      const o = opts.item(i);
      if (!o) continue;
      if (options.length < cap) {
        options.push({ index: i, value: String(o.value ?? ''), label: String(o.text ?? '') });
      }
    }
  }
  return {
    multiple: sel?.multiple === true,
    options,
    selectedIndex: typeof sel?.selectedIndex === 'number' ? sel.selectedIndex : -1,
  };
}

/**
 * Pick the option the caller named: an exact visible-label match wins, then an
 * exact value match. Deliberately exact — a substring match would let `type "a"`
 * silently pick the first of twenty options, which is the kind of
 * plausible-looking success this fix plan exists to remove.
 */
export function matchOption(
  options: PageOption[],
  text: string,
): { chosen: PageOption; ambiguous: number } | null {
  const byLabel = options.filter((o) => o.label === text);
  if (byLabel.length) return { chosen: byLabel[0], ambiguous: byLabel.length };
  const byValue = options.filter((o) => o.value === text);
  if (byValue.length) return { chosen: byValue[0], ambiguous: byValue.length };
  return null;
}

/**
 * How one action names its target in two different voices, because the existing
 * contract uses both: `targetLabel` is what the failure wrapper quotes
 * (`element 4 ("x")` / `selector "#s"`), `subject` is what prose addresses
 * (`element 4 ("x")` / `"#s"`, so success still reads `typed into "#s"`).
 */
interface ActionTarget {
  targetLabel: string;
  subject: string;
}

/** The refusal for a target no input mode can write into. */
function notEditable(el: IndexTarget, index: number): Error {
  return new Error(
    `browser_type: the element at index ${index} ("${el.text || el.role}") is not ` +
      'editable (no text input, textarea, select, or contenteditable). Use browser_click for ' +
      'a button or link, or browser_inspect to pick a text field',
  );
}

/** The shared dropdown flow; the two adapters below supply the Playwright calls. */
async function chooseOptionFlow(
  t: ActionTarget,
  text: string,
  read: () => Promise<SelectState>,
  selectByIndex: (optionIndex: number, timeoutMs: number) => Promise<unknown>,
): Promise<string> {
  const deadline = Date.now() + LOCATOR_ACTION_TIMEOUT_MS;
  let state: SelectState;
  try {
    state = await read();
  } catch (err) {
    throw new Error(
      `browser_type: ${t.subject} is a dropdown whose options could not be read ` +
        `(${err instanceof Error ? err.message : String(err)}); call browser_inspect again`,
    );
  }
  const match = matchOption(state.options, text);
  if (!match) throw new Error(selectOptionRefusal(t.subject, text, state.options, null));
  // The two locator calls share ONE action budget: reading the options is part
  // of the same action, so a dropdown can never cost more than the documented
  // 5 s the way two full timeouts would.
  const remaining = remainingActionTimeout(deadline, Date.now());
  if (remaining === null) {
    throw new Error(
      `browser_type: ${t.subject} is a dropdown and reading its options used the whole ` +
        `${LOCATOR_ACTION_TIMEOUT_MS} ms action budget; try again`,
    );
  }
  await withLocatorActionTimeout(
    'type',
    `${t.targetLabel} (dropdown option "${match.chosen.label}")`,
    () => selectByIndex(match.chosen.index, remaining),
  );
  // Read the control back rather than reporting the intent: a success line never
  // claims a choice the control did not actually make.
  const after = await read().catch(() => null);
  const landed = after && after.selectedIndex >= 0 ? after.options[after.selectedIndex] : null;
  if (!landed || landed.index !== match.chosen.index) {
    throw new Error(
      `browser_type: ${t.subject} did not end on "${match.chosen.label}" ` +
        `(it now holds ${landed ? `"${landed.label}"` : 'nothing'}); call browser_inspect again`,
    );
  }
  const shown =
    landed.label === landed.value
      ? `"${landed.label}"`
      : `"${landed.label}" (value: ${landed.value})`;
  const notes: string[] = [];
  if (state.multiple) notes.push('a multi-select: this replaced any previous choice');
  if (match.ambiguous > 1)
    notes.push(`${match.ambiguous} options share that label, took the first`);
  return `selected ${shown} in ${t.subject}${notes.length ? ` — note: ${notes.join('; ')}` : ''}`;
}

/**
 * Apply a `browser_type` call to an already-rechecked index target, using the
 * mode that recheck decided. Every failure names the tool, the element, and what
 * to do instead.
 */
export async function typeIntoTarget(
  el: IndexTarget,
  text: string,
  index: number,
): Promise<string> {
  if (el.mode === 'none') throw notEditable(el, index);
  const t: ActionTarget = {
    targetLabel: `element ${index} ("${el.text || el.role}")`,
    subject: `element ${index} ("${el.text || el.role}")`,
  };
  if (el.mode === 'fill') {
    // `fill` targets the node itself; a click-then-keyboard-type could land on
    // whatever the click actually hit.
    await withLocatorActionTimeout('type', t.targetLabel, () =>
      el.handle.fill(text, { timeout: LOCATOR_ACTION_TIMEOUT_MS }),
    );
    return `typed into ${t.subject}`;
  }
  return chooseOptionFlow(
    t,
    text,
    () => el.handle.evaluate(readSelectState),
    (optionIndex, timeoutMs) =>
      el.handle.selectOption({ index: optionIndex }, { timeout: timeoutMs }),
  );
}

/**
 * The selector form of the same decision. The snapshot machinery is index-based,
 * so a selector target has no recheck to carry a mode; the tag name is the whole
 * distinction here, and a `<select>` gets the dropdown flow while anything else
 * keeps Playwright's `fill`.
 *
 * The tag read is itself a locator action and is bounded and named like one: an
 * unbounded `locator.evaluate` waits on Playwright's 30-second default, which
 * would restore exactly the latency Phase 3 removed for a typo in a selector.
 */
export async function typeIntoLocator(
  locator: Locator,
  text: string,
  selector: string,
): Promise<string> {
  const target = locator.first();
  const t: ActionTarget = { targetLabel: `selector "${selector}"`, subject: `"${selector}"` };
  const tag = await withLocatorActionTimeout('type', t.targetLabel, () =>
    target.evaluate(
      (el: unknown) => String((el as { tagName?: string }).tagName ?? '').toLowerCase(),
      undefined,
      { timeout: LOCATOR_ACTION_TIMEOUT_MS },
    ),
  );
  if (tag !== 'select') {
    await withLocatorActionTimeout('type', t.targetLabel, () =>
      target.fill(text, { timeout: LOCATOR_ACTION_TIMEOUT_MS }),
    );
    return `typed into ${t.subject}`;
  }
  return chooseOptionFlow(
    t,
    text,
    () => target.evaluate(readSelectState, undefined, { timeout: LOCATOR_ACTION_TIMEOUT_MS }),
    (optionIndex, timeoutMs) => target.selectOption({ index: optionIndex }, { timeout: timeoutMs }),
  );
}
