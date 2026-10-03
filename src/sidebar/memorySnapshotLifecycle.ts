import type { SidebarRuntime } from './sessionTypes';
import { retainLiveMemoryKeys } from './compactionWindow';

/** Reconcile every loaded chat with the current workspace memory index. */
export function retainSessionMemoryKeys(
  session: SidebarRuntime,
  liveKeys: readonly string[],
): boolean {
  let changed = false;
  for (const conversation of [...session.conversations, ...session.history]) {
    const retained = retainLiveMemoryKeys(conversation.compaction, liveKeys);
    if (!retained || retained === conversation.compaction) continue;
    conversation.compaction = retained;
    conversation.updatedAt = Date.now();
    changed = true;
  }
  return changed;
}
