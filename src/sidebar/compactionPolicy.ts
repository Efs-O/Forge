/**
 * Supplying the runtime that compaction needs, and the auto-continue
 * accounting around it.
 *
 * Split out of `SidebarProvider`. The resume *policy* lives in
 * CompactionService; what belongs here is the distinction between the two entry
 * points, which is easy to lose when both are inline method bodies:
 *
 * - threshold-triggered compaction resumes only when the user has left it
 *   enabled, and is bounded by the auto-continue counter so a stuck task cannot
 *   resume itself forever;
 * - a manual `/compact` always resumes once and is never counted, because the
 *   user just asked for it.
 */

import type { HostToWebview } from './messageBridge';
import { autoCompactAndResume, resumeAfterCompaction } from './CompactionService';
import type { CompactionOutcome } from './CompactionService';
import type { UserPromptOptions } from './transcriptMutations';

export interface CompactionPolicyDeps {
  post: (msg: HostToWebview) => void;
  compact: (options: { auto: boolean }) => Promise<CompactionOutcome>;
  incompleteTurnReason: (convId: string) => string | undefined;
  /** Addressed to the conversation that was compacted, not to whatever tab is
   *  active by the time the summary lands. */
  send: (text: string, convId: string, options?: UserPromptOptions) => Promise<void>;
  resumeEnabled: boolean;
  autoContinues: () => number;
  noteAutoContinue: () => void;
}

/** Threshold-triggered: bounded, and only if the user left resume enabled. */
export function runAutoCompact(deps: CompactionPolicyDeps, convId: string): Promise<void> {
  return autoCompactAndResume({
    convId,
    post: deps.post,
    compact: deps.compact,
    incompleteTurnReason: () => deps.incompleteTurnReason(convId),
    resumeEnabled: deps.resumeEnabled,
    autoContinues: deps.autoContinues,
    noteAutoContinue: deps.noteAutoContinue,
    send: (text, options) => deps.send(text, convId, options),
  });
}

/** User-invoked `/compact`: always resumes once, never counted against the cap. */
export function runManualCompactResume(deps: CompactionPolicyDeps, convId: string): Promise<void> {
  return resumeAfterCompaction(
    {
      convId,
      post: deps.post,
      incompleteTurnReason: () => deps.incompleteTurnReason(convId),
      resumeEnabled: true,
      autoContinues: () => 0,
      noteAutoContinue: () => undefined,
      send: (text, options) => deps.send(text, convId, options),
    },
    { automatic: false },
  );
}
