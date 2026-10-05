/**
 * The inspection snapshot an index action is bound to
 * (docs/plans/DESKTOP_BROWSER_TOOL_FIX_PLAN.md Phase 1, item 3).
 *
 * `BrowserSessionManager` owns the one instance of this, per page — it is the
 * manager's data structure, not a second state owner. What lives here is the
 * bookkeeping that makes an inspect index mean the same thing twice: enumerate
 * the elements, keep a handle on the exact node each entry came from, and on
 * request re-check that node against the live DOM before any input lands.
 *
 * The page-side facts and the rules that turn them into a refusal live in
 * `browserInspect.ts`; this module only moves handles.
 */
import type { ElementHandle, Page } from 'playwright-core';
import {
  INTERACTIVE_SELECTOR,
  clampInspectMax,
  collectInteractiveElements,
  recheckNode,
  roleFromFacts,
  textFromFacts,
  verdictForRecheck,
  type BrowserElement,
  type ElementFacts,
  type IndexTarget,
  type InspectPageArgs,
  type NodeRecheck,
  type RecheckExpected,
} from './browserInspect';

/** One retained inspection entry: the DOM node itself plus what it reported. */
interface InspectionEntry {
  index: number;
  role: string;
  text: string;
  selector: string;
  bbox: { x: number; y: number; width: number; height: number };
  facts: ElementFacts;
  /**
   * The node, not a selector. A unique selector plus a role/text comparison
   * cannot prove identity — inserting an identical sibling shifts an
   * `nth-of-type` path onto the new node and both halves still match — so the
   * action path re-checks THIS handle.
   */
  handle: ElementHandle;
}

/** The inspection an index action must be bound to (replaced on every inspect). */
interface InspectionSnapshot {
  url: string;
  entries: InspectionEntry[];
}

export class InspectionStore {
  private readonly snapshots = new Map<Page, InspectionSnapshot>();
  /** Names the per-inspect node array published in the page; unique per call. */
  private counter = 0;

  /** Entries currently retained for a tab (0 when it has never been inspected). */
  sizeFor(page: Page): number {
    return this.snapshots.get(page)?.entries.length ?? 0;
  }

  /**
   * Enumerate the tab's interactive elements and REPLACE this tab's snapshot.
   * An empty page yields no entries; an unexpected non-array page result is a
   * named `browser_inspect` error rather than a silent empty list.
   */
  async capture(page: Page, max: unknown): Promise<BrowserElement[]> {
    const limit = clampInspectMax(max);
    const nodeKey = `__forgeInspect${++this.counter}`;
    // A real callback, not a stringified one: `page.evaluate` evaluates a string
    // as an *expression*, so the previous form resolved to an unserializable
    // function object, returned `undefined`, and the DOM code never ran
    // (report §3.2, microsoft/playwright#26851).
    const args: InspectPageArgs = { selector: INTERACTIVE_SELECTOR, limit, nodeKey };
    let raw: unknown;
    try {
      raw = await page.evaluate(collectInteractiveElements, args);
    } catch (err) {
      throw new Error(`browser_inspect: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(raw)) {
      throw new Error(
        `browser_inspect: unexpected ${raw === null ? 'null' : typeof raw} result from the page ` +
          'script (expected an array of elements)',
      );
    }
    const handles = await this.pinnedNodes(page, nodeKey);
    const entries: InspectionEntry[] = [];
    for (const item of raw) {
      const e = item as { index?: unknown; selector?: unknown; bbox?: unknown; facts?: unknown };
      if (typeof e?.index !== 'number' || typeof e?.selector !== 'string' || !e.facts) continue;
      const bbox = e.bbox as { x: number; y: number; width: number; height: number } | undefined;
      if (!bbox || !Number.isFinite(bbox.x) || !Number.isFinite(bbox.y)) continue;
      const handle = handles[e.index];
      if (!handle) continue;
      const facts = e.facts as ElementFacts;
      entries.push({
        index: e.index,
        role: roleFromFacts(facts),
        text: textFromFacts(facts),
        selector: e.selector,
        bbox,
        facts,
        handle,
      });
    }
    // Replace, never merge: an index means what it meant in the list the model
    // is looking at, and only while that snapshot stands.
    this.drop(page);
    this.snapshots.set(page, { url: page.url(), entries });
    return entries.map(({ handle: _handle, facts: _facts, ...rest }) => rest);
  }

  /**
   * Resolve an inspect index to the SAME node it named, rechecked against the
   * live DOM. Refuses a missing snapshot, a stale URL, a detached, hidden,
   * disabled, or non-fillable node, and a node whose role or text changed —
   * each naming what to do instead. Page script can mutate the DOM without
   * navigating, so the recheck runs even when the snapshot exists.
   */
  async resolve(page: Page, index: number, action: string): Promise<IndexTarget> {
    const snapshot = this.snapshots.get(page);
    if (!snapshot) {
      throw new Error(`browser_${action}: no inspection for this tab; call browser_inspect first`);
    }
    const entry = snapshot.entries.find((e) => e.index === index);
    if (!entry) {
      throw new Error(
        `browser_${action}: no element at index ${index} in the last inspection ` +
          `(${snapshot.entries.length} element(s)); call browser_inspect`,
      );
    }
    const url = page.url();
    if (url !== snapshot.url) {
      this.drop(page);
      throw new Error(
        `browser_${action}: index ${index} is stale — the tab moved from ${snapshot.url} to ` +
          `${url}; call browser_inspect again`,
      );
    }
    const expected: RecheckExpected = {
      role: entry.role,
      text: entry.text,
      tag: entry.facts.tag,
      action,
      index,
    };
    let verdict: NodeRecheck;
    try {
      verdict = await entry.handle.evaluate(recheckNode);
    } catch (err) {
      throw new Error(
        `browser_${action}: index ${index} no longer refers to a live element ` +
          `(${err instanceof Error ? err.message : String(err)}); call browser_inspect again`,
      );
    }
    const checked = verdictForRecheck(verdict, expected);
    if (!checked.ok) throw new Error(checked.message);
    return { role: entry.role, text: entry.text, handle: entry.handle, editable: checked.editable };
  }

  /** Dispose a tab's retained handles and forget its snapshot. Fire-and-forget. */
  drop(page: Page): void {
    const snapshot = this.snapshots.get(page);
    this.snapshots.delete(page);
    if (!snapshot) return;
    for (const entry of snapshot.entries) entry.handle.dispose().catch(() => undefined);
  }

  /** Dispose everything (browser close). */
  dropAll(): void {
    for (const page of this.snapshots.keys()) this.drop(page);
  }

  /** Read (and un-publish) the node array the inspect callback stored. */
  private async pinnedNodes(page: Page, nodeKey: string): Promise<ElementHandle[]> {
    try {
      const list = await page.evaluateHandle((key: string) => {
        const store = globalThis as unknown as Record<string, unknown>;
        const nodes = store[key];
        delete store[key];
        return nodes ?? null;
      }, nodeKey);
      const properties = await list.getProperties();
      const handles = [...properties.values()]
        .map((handle) => handle.asElement())
        .filter((handle): handle is ElementHandle => handle !== null);
      await list.dispose();
      return handles;
    } catch (err) {
      throw new Error(
        `browser_inspect: could not retain the inspected elements ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}
