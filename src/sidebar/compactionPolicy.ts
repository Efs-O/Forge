/**
 * Manual post-compaction recovery for the active sidebar command.
 *
 * Split out of `SidebarProvider`. The resume *policy* lives in
 * CompactionService; what belongs here is the distinction between the two entry
 * points, which is easy to lose when both are inline method bodies:
 *
 * A manual `/compact` leaves an idle conversation idle, but resumes once
 *   when the preceding turn was interrupted. That recovery is never counted
 *   against the automatic continuation cap.
 */

import type { HostToWebview } from './messageBridge';
import { RESUME_PROMPT } from './CompactionService';
import type { UserPromptOptions } from './transcriptMutations';

export interface CompactionPolicyDeps {
  post: (msg: HostToWebview) => void;
  /** Addressed to the conversation that was compacted, not to whatever tab is
   *  active by the time the summary lands. */
  send: (text: string, convId: string, options?: UserPromptOptions) => Promise<void>;
}

/** User-invoked recovery after `/compact`: only called for an interrupted turn. */
export function runManualCompactResume(
  deps: CompactionPolicyDeps,
  convId: string,
  reason: string,
): Promise<void> {
  deps.post({ type: 'generationStarted', conversationId: convId });
  deps.post({
    type: 'notice',
    message: `Context compacted mid-task (${reason}). Resuming.`,
    conversationId: convId,
  });
  return deps.send(RESUME_PROMPT, convId, { internal: true }).catch((err) => {
    deps.post({
      type: 'error',
      message: `Forge: could not resume after compaction — ${(err as Error).message}`,
      conversationId: convId,
    });
  });
}
