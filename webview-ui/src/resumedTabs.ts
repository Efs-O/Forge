import type { SessionTabMeta } from '../../src/sidebar/messageBridge';

/**
 * How stale a tab must be before reopening it is treated as resuming rather
 * than continuing. Long enough that closing the laptop over lunch does not
 * trigger the marker; short enough to catch the overnight case.
 */
export const RESUMED_AFTER_MS = 4 * 60 * 60 * 1000;

/**
 * Which tabs count as resumed, snapshotted once when the session hydrates.
 *
 * Deliberately a snapshot, not a live read: `updatedAt` moves on any activity,
 * so recomputing per render would make the marker vanish mid-session and
 * reappear on unrelated syncs.
 */
export function resumedTabIds(tabs: SessionTabMeta[], now: number): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabs) {
    if ((tab.messageCount ?? 0) <= 0) continue;
    if (now - tab.updatedAt > RESUMED_AFTER_MS) ids.add(tab.id);
  }
  return ids;
}

/** The marker's text, or null when this tab is not a resumed one. */
export function resumedNoteFor(
  tab: SessionTabMeta | undefined,
  resumedIds: ReadonlySet<string>,
  relativeTime: (ts: number) => string,
): string | null {
  if (!tab || !resumedIds.has(tab.id)) return null;
  const count = tab.messageCount ?? 0;
  return `resumed · ${relativeTime(tab.updatedAt)} · ${count} msg${count === 1 ? '' : 's'}`;
}
