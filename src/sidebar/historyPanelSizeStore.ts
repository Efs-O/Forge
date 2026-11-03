/**
 * The history panel's stored size: the host half — one `globalState` key, one
 * schema, and the two operations the host performs on it.
 *
 * `globalState`, not `workspaceState`, because the size belongs to the person
 * who sized it: every window on this machine should open the panel the same
 * width and height, and a second window has no way to learn the size except by
 * reading the key back. It is the panel's only stored preference, so this file
 * is the whole of its persistence — read, validate, store, forget. The shape
 * and the bounds live in `historyPanelSize.ts`, which the webview also reads;
 * this one is host-only, because it needs `zod` and the Forge log channel.
 *
 * The host validates what the webview sends and stores what it validated. A
 * stored value it cannot use is deleted rather than left to fail on every load,
 * and the line that says so names the key, so a hand-edited state database is
 * findable from the log alone.
 */
import { z } from 'zod';
import type * as vscode from 'vscode';
import { getLogger } from '../util/logger';
import {
  PANEL_MAX_HEIGHT,
  PANEL_MAX_WIDTH,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  type HistoryPanelSize,
} from './historyPanelSize';

/**
 * The Forge log channel, as this module needs it: one line saying a stored
 * value was thrown away. Written as an interface rather than inferred from
 * `getLogger()`, so a test can capture the line instead of watching an Output
 * Channel, and so the declaration checker is not handed an anonymous class with
 * private members (TS4094).
 */
export interface PanelSizeLog {
  warn(message: string): void;
}

/** The one key this panel owns. A reset deletes it; nothing else writes it. */
export const HISTORY_PANEL_SIZE_KEY = 'forge.historyPanel.size';

/** Integers inside the stored bounds, and nothing else may sit under the key. */
export const historyPanelSizeSchema = z
  .object({
    width: z.number().int().min(PANEL_MIN_WIDTH).max(PANEL_MAX_WIDTH),
    height: z.number().int().min(PANEL_MIN_HEIGHT).max(PANEL_MAX_HEIGHT),
  })
  .strict();

/** Read the saved size, or `undefined` for the default. An unusable stored value is removed and logged once. */
export function readHistoryPanelSize(
  store: vscode.Memento | undefined,
  log: PanelSizeLog = getLogger(),
): HistoryPanelSize | undefined {
  if (!store) return undefined;
  const stored = store.get<unknown>(HISTORY_PANEL_SIZE_KEY, undefined);
  if (stored === undefined) return undefined;
  const parsed = historyPanelSizeSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  void store.update(HISTORY_PANEL_SIZE_KEY, undefined);
  log.warn(
    `[HistoryPanel] removed unusable ${HISTORY_PANEL_SIZE_KEY} ` +
      `(${JSON.stringify(stored)}): ${parsed.error.message}`,
  );
  return undefined;
}

/** Store the size the webview settled on; `null` forgets it, so the default returns. */
export function storeHistoryPanelSize(
  store: vscode.Memento | undefined,
  size: HistoryPanelSize | null,
  log: PanelSizeLog = getLogger(),
): void {
  if (!store) return;
  if (size === null) {
    // `undefined`, not a value: the key's absence is what makes the default the
    // default again. Writing the default here would store a size nobody chose,
    // and the next window could not tell "reset" from "resized to 480".
    void store.update(HISTORY_PANEL_SIZE_KEY, undefined);
    return;
  }
  const parsed = historyPanelSizeSchema.safeParse(size);
  if (!parsed.success) {
    // A message from a stale or patched webview is refused rather than trusted:
    // this key is the only thing the panel reads back on the next load.
    log.warn(`[HistoryPanel] refused an out-of-range panel size: ${parsed.error.message}`);
    return;
  }
  void store.update(HISTORY_PANEL_SIZE_KEY, parsed.data);
}
