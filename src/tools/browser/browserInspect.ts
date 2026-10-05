import type { ElementHandle } from 'playwright-core';

/**
 * The DOM side of `browser_inspect` (docs/plans/DESKTOP_BROWSER_TOOL_FIX_PLAN.md
 * Phase 1). Two modules carry this fix, so `BrowserSessionManager.ts` — which
 * sits at the 500-line `max-lines` limit — keeps owning the session and the
 * snapshot while neither helper duplicates transport or state:
 *
 *  - THIS file: the page callbacks plus the pure rules that turn the facts they
 *    report into a `role`, a `text`, an "is it fillable" answer, or an index
 *    refusal. No state, no browser needed to test it.
 *  - `browserInspectionStore.ts`: the per-tab snapshot and its element handles.
 *
 * The page callbacks report FACTS (attributes, geometry, visibility) only; every
 * comparison happens here in TypeScript so each rule has exactly one
 * implementation.
 *
 * Playwright serializes a callback's source and runs it in the page. This file
 * is compiled against the Node lib (no DOM lib in the extension build), so the
 * page-side shape is declared locally and reached through `globalThis` — the
 * pattern `src/tools/renderHtml/renderEngine.ts` already uses.
 */

/**
 * Heuristic interactive-element selector (plan §4.2): a numbered target list,
 * NOT the full accessibility tree (a non-goal).
 */
export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[onclick]',
  '[contenteditable="true"]',
  'summary',
].join(',');

/** Default and hard ceiling for one `browser_inspect` call. */
export const DEFAULT_INSPECT_MAX = 50;
export const MAX_INSPECT_ELEMENTS = 500;
/**
 * How much raw text a page callback may return per element (the literal is
 * inlined in both page callbacks: Playwright serializes only the callback's own
 * source, so a module-scope name would be undefined in the page). The derived
 * label keeps only the first 80 characters after trimming, so this only bounds
 * the transport for an element that wraps a large subtree.
 */
export const TEXT_SCAN_LIMIT = 400;

/** Clamp an explicit `max` so one call cannot produce an unbounded result. */
export function clampInspectMax(max: unknown): number {
  const n = typeof max === 'number' && Number.isFinite(max) ? Math.floor(max) : DEFAULT_INSPECT_MAX;
  if (n < 1) return DEFAULT_INSPECT_MAX;
  return Math.min(n, MAX_INSPECT_ELEMENTS);
}

/** The serializable payload the inspect callback receives. */
export interface InspectPageArgs {
  selector: string;
  limit: number;
  /**
   * When set, the callback also stores the matched nodes as an array on
   * `globalThis[nodeKey]`, in the same order as the returned entries. The
   * manager reads that array back as element handles, so an entry's handle is
   * the SAME node its facts came from. Re-querying the document in a second
   * call could otherwise land on a different node if a page timer mutated the
   * DOM between the two round trips.
   */
  nodeKey?: string;
}

/**
 * The attribute/geometry facts one element reports, read straight off the node.
 * Deliberately raw: no role mapping, no text precedence, no editability rule.
 */
export interface ElementFacts {
  /** The `role` ATTRIBUTE (null when absent) — not a computed role. */
  role: string | null;
  /** Lowercased tag name. */
  tag: string;
  /** The `type` attribute (null when absent). */
  type: string | null;
  ariaLabel: string | null;
  title: string | null;
  /** Truncated in the page: the derived text only ever needs the first 80 chars. */
  textContent: string | null;
  placeholder: string | null;
  /** The `value` ATTRIBUTE (not the live property). */
  value: string | null;
  /** The `contenteditable` attribute ('', 'true', 'false', or null). */
  contentEditable: string | null;
  readOnly: boolean;
  disabled: boolean;
}

/** One entry as the page callback returns it: facts + a unique selector + geometry. */
export interface InspectedDomEntry {
  index: number;
  selector: string;
  bbox: { x: number; y: number; width: number; height: number };
  facts: ElementFacts;
}

/** A numbered interactive element from `browser_inspect` (heuristic, not the a11y tree). */
export interface BrowserElement {
  index: number;
  role: string;
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  /** A CSS selector that re-selects this element (best-effort, DOM-stable). */
  selector: string;
}

/** A snapshot entry that passed every recheck, ready to act on. */
export interface IndexTarget {
  role: string;
  text: string;
  /** The retained node itself — the caller acts on this, never on a selector. */
  handle: ElementHandle;
  /** How `browser_type` may put text into it: fill it, or choose an option. */
  mode: InputMode;
}

/** What the stored entry claimed, and who is asking (for the refusal text). */
export interface RecheckExpected {
  role: string;
  text: string;
  tag: string;
  action: string;
  index: number;
}

/** The verdict of comparing a live recheck against what the snapshot stored. */
export type RecheckVerdict =
  | { ok: true; mode: InputMode; role: string; text: string }
  | { ok: false; message: string };

/** What the live DOM node behind a snapshot entry still reports. */
export interface NodeRecheck {
  attached: boolean;
  /** Only meaningful when `attached`; layout + hit-test verdict, page-side. */
  visible?: boolean;
  facts?: ElementFacts;
}

/** Input types that render a text control but cannot be typed into. */
const NON_FILLABLE_INPUT_TYPES = [
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'file',
  'image',
  'color',
  'range',
];

/** The display role for `browser_inspect`: declared role, then a tag mapping. */
export function roleFromFacts(f: ElementFacts): string {
  if (f.role) return f.role;
  if (f.tag === 'a') return 'link';
  if (f.tag === 'input') return f.type ?? 'input';
  return f.tag;
}

/** The label shown for an element: aria-label, title, text, placeholder, value. */
export function textFromFacts(f: ElementFacts): string {
  // The first candidate with actual content wins. An empty string must NOT stop
  // the chain: `textContent` on an `<input>`, `<select>`, or `<img>` is `''`
  // rather than null, so a strict `??` chain made the documented
  // placeholder/value fallbacks unreachable — an empty search box was labelled
  // "" instead of its placeholder (and a value-only button likewise).
  const candidates = [f.ariaLabel, f.title, f.textContent, f.placeholder, f.value];
  for (const c of candidates) {
    if (c == null) continue;
    const trimmed = String(c).trim();
    if (trimmed !== '') return trimmed.slice(0, 80);
  }
  return '';
}

/**
 * How `browser_type` can put text into a node — decided in exactly ONE place.
 *
 * `fill` is Playwright's text-entry primitive and it refuses a `<select>`
 * outright, so "can this take text?" is not one question but two: a text field
 * to fill, or a dropdown whose value is chosen from its options. Collapsing them
 * (the original bug) let the guard wave a `<select>` through and then fail 5
 * seconds later inside `fill` with Playwright's own wording.
 */
export type InputMode = 'fill' | 'select' | 'none';

/**
 * True when `browser_type` can put text into this element. Mirrors what
 * Playwright's `fill` accepts: a text-like input, a textarea, or a
 * `contenteditable` node.
 */
export function inputModeFor(f: ElementFacts): InputMode {
  if (f.disabled) return 'none';
  if (f.tag === 'select') return 'select';
  const ce = f.contentEditable;
  if (ce === '' || ce === 'true') return 'fill';
  if (ce === 'false') return 'none';
  if (f.tag === 'textarea') return f.readOnly ? 'none' : 'fill';
  if (f.tag === 'input') {
    if (f.readOnly) return 'none';
    return NON_FILLABLE_INPUT_TYPES.includes((f.type ?? 'text').toLowerCase()) ? 'none' : 'fill';
  }
  return 'none';
}

/**
 * The single place an index-action refusal is decided: compare the live
 * recheck of the retained node against what the snapshot stored, and say why it
 * cannot be used. Pure, so the whole failure surface — detached, hidden,
 * disabled, changed, unreadable — is testable without a browser.
 */
export function verdictForRecheck(v: NodeRecheck, e: RecheckExpected): RecheckVerdict {
  const name = `browser_${e.action}`;
  if (!v || v.attached !== true) {
    return {
      ok: false,
      message:
        `${name}: the element at index ${e.index} is no longer in the document; ` +
        'call browser_inspect again',
    };
  }
  const facts = v.facts;
  if (!facts) {
    return {
      ok: false,
      message: `${name}: could not re-read the element at index ${e.index}; call browser_inspect again`,
    };
  }
  const role = roleFromFacts(facts);
  const text = textFromFacts(facts);
  if (role !== e.role || text !== e.text) {
    return {
      ok: false,
      message:
        `${name}: the element at index ${e.index} changed (was ${e.role} "${e.text}", ` +
        `now ${role} "${text}"); call browser_inspect again`,
    };
  }
  if (facts.disabled) {
    return {
      ok: false,
      message:
        `${name}: the element at index ${e.index} ("${text || role}") is disabled; it cannot ` +
        'receive input',
    };
  }
  if (v.visible !== true) {
    return {
      ok: false,
      message:
        `${name}: the element at index ${e.index} ("${text || role}") is not visible or is ` +
        'covered by something else, so the input would not land on it. Scroll it into view or ' +
        'close the overlay, then call browser_inspect again',
    };
  }
  return { ok: true, mode: inputModeFor(facts), role, text };
}

/** The minimal page-side DOM shape the callbacks below use. */
interface PageElement {
  nodeType: number;
  tagName: string;
  id: string;
  isConnected: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  previousElementSibling: PageElement | null;
  parentElement: PageElement | null;
  contains(other: PageElement | null): boolean;
}

interface PageDocument {
  querySelectorAll(selector: string): { length: number; item(i: number): PageElement | null };
  elementFromPoint(x: number, y: number): PageElement | null;
}

interface PageWindow {
  document: PageDocument;
  CSS: { escape(value: string): string };
  getComputedStyle(el: PageElement): {
    display: string;
    visibility: string;
    opacity: string;
  };
  innerWidth: number;
  innerHeight: number;
  [key: string]: unknown;
}

/**
 * Enumerate interactive elements: `{index, selector, bbox, facts}` per element,
 * capped at `args.limit`. An empty page returns `[]`.
 *
 * This is a REAL callback, not a stringified one. `page.evaluate` evaluates a
 * string argument as an *expression*, so the old `` `(obj) => {…}` `` form
 * resolved to an unserializable function object, came back `undefined`, and the
 * DOM code never ran (report §3.2; microsoft/playwright#26851).
 */
export function collectInteractiveElements(args: InspectPageArgs): InspectedDomEntry[] {
  const win = globalThis as unknown as PageWindow;
  const doc = win.document;
  const css = win.CSS;

  /**
   * A CSS path that identifies this node in the CURRENT document: every
   * ancestor's `tag:nth-of-type(n)`, from `html` down. A bare leaf
   * `nth-of-type` is not unique — it says nothing about which parent it sits
   * under, and an identical sibling inserted before the target shifts it onto a
   * different node. An ID is used only when it is genuinely unique in the
   * document (duplicate ids are legal HTML and `#id` would then be ambiguous).
   */
  const uniquePath = (el: PageElement): string => {
    if (el.id && doc.querySelectorAll('#' + css.escape(el.id)).length === 1) {
      return '#' + css.escape(el.id);
    }
    const parts: string[] = [];
    let node: PageElement | null = el;
    while (node && node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'html') {
        parts.unshift('html');
        break;
      }
      let n = 1;
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName.toLowerCase() === tag) n++;
      }
      parts.unshift(tag + ':nth-of-type(' + n + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const readFacts = (el: PageElement): ElementFacts => ({
    role: el.getAttribute('role'),
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    ariaLabel: el.getAttribute('aria-label'),
    title: el.getAttribute('title'),
    // Capped in the page: the derived label only ever keeps the first 80 chars
    // after trimming, and an element can wrap the whole page's text. The 400 is
    // TEXT_SCAN_LIMIT, inlined because this body is serialized into the page.
    textContent: capText(el),
    placeholder: el.getAttribute('placeholder'),
    value: el.getAttribute('value'),
    contentEditable: el.getAttribute('contenteditable'),
    readOnly: el.readOnly === true,
    disabled: el.disabled === true,
  });

  /** Mirrors `recheckNode`'s reader exactly (see the sync note there). */
  const capText = (el: PageElement): string | null => {
    if (el.getAttribute('aria-label') !== null || el.getAttribute('title') !== null) return null;
    const raw = (el as unknown as { textContent?: string | null }).textContent;
    if (raw == null) return null;
    return raw.length > 400 ? raw.slice(0, 400) : raw;
  };

  const nodes: PageElement[] = [];
  const matched = doc.querySelectorAll(args.selector);
  for (let i = 0; i < matched.length && nodes.length < args.limit; i++) {
    const el = matched.item(i);
    if (el) nodes.push(el);
  }
  if (args.nodeKey) win[args.nodeKey] = nodes;
  return nodes.map((el, index) => {
    const rect = el.getBoundingClientRect();
    return {
      index,
      selector: uniquePath(el),
      bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      facts: readFacts(el),
    };
  });
}

/**
 * The page-side recheck of ONE node: still attached, and (when attached) visible
 * plus its current facts. The node arrives as the callback's first argument —
 * the manager passes the ORIGINAL handle it kept, so this runs against that
 * node whatever the document looks like now.
 *
 * This is why a selector plus a role/text comparison is not enough: an
 * identical sibling inserted before the target moves a `nth-of-type` selector
 * onto the new node and both halves of the comparison still match.
 */
export function recheckNode(target: PageElement): NodeRecheck {
  const win = globalThis as unknown as PageWindow;
  if (!target || target.nodeType !== 1 || !target.isConnected) return { attached: false };

  /** Byte-identical to the reader in `collectInteractiveElements` (see note below). */
  const capText = (el: PageElement): string | null => {
    if (el.getAttribute('aria-label') !== null || el.getAttribute('title') !== null) return null;
    const raw = (el as unknown as { textContent?: string | null }).textContent;
    if (raw == null) return null;
    return raw.length > 400 ? raw.slice(0, 400) : raw;
  };

  const rect = target.getBoundingClientRect();
  const style = win.getComputedStyle(target);
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  let visible =
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0' &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x + rect.width > 0 &&
    rect.y + rect.height > 0 &&
    rect.x < vw &&
    rect.y < vh;
  if (visible) {
    // Hit-test the centre: an overlay covering the element makes a click land
    // somewhere else, which is exactly the silent no-op this recheck exists to
    // prevent.
    const cx = Math.min(Math.max(rect.x + rect.width / 2, 0), Math.max(vw - 1, 0));
    const cy = Math.min(Math.max(rect.y + rect.height / 2, 0), Math.max(vh - 1, 0));
    const hit = win.document.elementFromPoint(cx, cy);
    if (hit && hit !== target && !target.contains(hit) && !hit.contains(target)) visible = false;
  }

  return {
    attached: true,
    visible,
    // Same fact set and same page-side capping as `collectInteractiveElements`.
    // Playwright serializes only the callback's own source, so this reader is
    // necessarily repeated; test/unit/BrowserInspectReaderSync.test.ts asserts
    // the two stay byte-identical.
    facts: {
      role: target.getAttribute('role'),
      tag: target.tagName.toLowerCase(),
      type: target.getAttribute('type'),
      ariaLabel: target.getAttribute('aria-label'),
      title: target.getAttribute('title'),
      textContent: capText(target),
      placeholder: target.getAttribute('placeholder'),
      value: target.getAttribute('value'),
      contentEditable: target.getAttribute('contenteditable'),
      readOnly: target.readOnly === true,
      disabled: target.disabled === true,
    },
  };
}
