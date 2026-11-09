/**
 * Conversation-local unattended markers.
 *
 * A job owns its marker for exactly one turn. This is deliberately separate
 * from clanker mode: unattended work may bypass only its own non-dangerous
 * confirmations, while an attended conversation keeps its normal gate.
 *
 * The marker carries the job's id and name (when the unattended conversation
 * is a job run), so `notify_user` can write its outbox item under the job id
 * with the job name — one coalesced outbox item per job (AC10) — instead of
 * under the conversation id with a "Unattended conversation <uuid>" name, which
 * is what Telegram would have shown the owner.
 */
export interface UnattendedJobMeta {
  /** The job id — the outbox key. */
  jobId: string;
  /** The job's display name — the outbox item name. */
  jobName: string;
}

export interface UnattendedConversationRegistry {
  /**
   * Mark a conversation unattended. `job` is present only for a job run; an
   * unattended conversation with no job (none today) carries no meta.
   */
  mark(conversationId: string, job?: UnattendedJobMeta): { dispose(): void };
  has(conversationId: string): boolean;
  /** The job meta for an unattended conversation, if the marker carries one. */
  jobMeta(conversationId: string): UnattendedJobMeta | undefined;
}

const ids = new Set<string>();
const jobMeta = new Map<string, UnattendedJobMeta>();

/** Shared registry used by the turn services and the job runner. */
export const unattendedConversations: UnattendedConversationRegistry = {
  mark(conversationId, job): { dispose(): void } {
    ids.add(conversationId);
    if (job) jobMeta.set(conversationId, job);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        ids.delete(conversationId);
        jobMeta.delete(conversationId);
      },
    };
  },

  has(conversationId): boolean {
    return ids.has(conversationId);
  },

  jobMeta(conversationId): UnattendedJobMeta | undefined {
    return jobMeta.get(conversationId);
  },
};

/**
 * Tools withheld from an unattended turn, with the refusal a blind call gets.
 * `ask_user` waits with no timeout, and nobody is present to answer it.
 */
const UNATTENDED_REFUSALS: ReadonlyMap<string, string> = new Map([
  [
    'ask_user',
    'ask_user: unavailable in an unattended turn, nobody is present to answer. ' +
      'Decide from what you have and state the assumption in your final answer.',
  ],
]);

/** Adds the unattended refusals to a turn's unavailable-tool map. */
export function withUnattendedRefusals(
  base: ReadonlyMap<string, string> | undefined,
  unattended: boolean,
): ReadonlyMap<string, string> | undefined {
  if (!unattended) return base;
  return new Map([...(base ?? []), ...UNATTENDED_REFUSALS]);
}
