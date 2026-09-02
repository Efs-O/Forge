import type { CompactionEvent } from '../sidebar/CompactionService';

/**
 * Delivery policy for host-originated compaction events:
 * - trigger 'auto'    → notify on started + finished (the primary capability)
 * - trigger 'remote'  → suppress (the /compact handler already sent progress)
 * - trigger 'sidebar' → suppress (local actions are not mirrored by default)
 *
 * A pure decision, deliberately kept out of `RemoteRuntime`: what a chat is told
 * about a compaction is a product rule that changes on its own schedule, and it
 * had no business sharing a file with transport lifecycle. Returning the text
 * rather than sending it is what makes the rule testable without a channel.
 */
export function remoteCompactionNotice(event: CompactionEvent): string | undefined {
  if (event.trigger !== 'auto') return undefined;
  if (event.phase === 'started') return 'Forge: compacting…';
  if (event.outcome === 'skipped') return undefined;
  return event.outcome === 'compacted'
    ? 'Forge: compaction complete.'
    : 'Forge: compaction failed.';
}
