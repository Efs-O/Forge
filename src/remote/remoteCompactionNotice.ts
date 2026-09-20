import type { CompactionEvent } from '../sidebar/CompactionService';

/**
 * Delivery policy for host-originated compaction events:
 * - trigger 'auto'    → completed compactions are AGGREGATED by
 *                        CompactionNoticeBuffer (one message per run, not per
 *                        compaction); a FAILED compaction is reported
 *                        immediately, after any pending successes flush
 * - trigger 'remote'  → suppress (the /compact handler already sent progress)
 * - trigger 'sidebar' → suppress (local actions are not mirrored by default)
 *
 * The "compacting…" started message was dropped: during a long unattended run
 * several auto-compactions produced a flurry of started/finished pairs on the
 * phone. The aggregated finished message is enough signal, and a manual
 * /compact from the phone still gets its own progress from RemoteCommandHandler.
 *
 * A pure decision, deliberately kept out of `RemoteRuntime`: what a chat is told
 * about a compaction is a product rule that changes on its own schedule, and it
 * had no business sharing a file with transport lifecycle. Returning the text
 * rather than sending it is what makes the rule testable without a channel.
 */
export function remoteCompactionNotice(event: CompactionEvent): string | undefined {
  if (event.trigger !== 'auto') return undefined;
  if (event.phase !== 'finished') return undefined;
  if (event.outcome === 'failed') return 'Forge: compaction failed.';
  return undefined;
}

/**
 * The aggregated line for N completed auto-compactions. One compaction keeps
 * the original singular wording; several collapse into a single count.
 */
export function compactionAggregationText(count: number): string {
  return count === 1 ? 'Forge: compaction complete.' : `Forge: ${count} compactions complete.`;
}
