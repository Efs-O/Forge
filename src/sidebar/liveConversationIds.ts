import type { SidebarRuntime } from './sessionTypes';

/** IDs whose bytes or checkpoint data remain reachable from the open/archived UI. */
export function liveConversationIds(
  sidebar: SidebarRuntime,
  overflow: readonly { id: string }[],
): string[] {
  return [...sidebar.conversations, ...sidebar.history, ...overflow].map((row) => row.id);
}
