export const RECORDED_ACTION_MAX_PER_KIND = 24;
export const RECORDED_ACTION_MAX_ITEMS = RECORDED_ACTION_MAX_PER_KIND * 2;
export const RECORDED_ACTION_KEY_MAX_CHARS = 300;
export const RECORDED_ACTION_LINE_MAX_CHARS = 800;
export const COMPACTION_REPO_STATE_MAX_CHARS = 2000;
export const COMPACTION_MEMORY_KEYS_MAX = 40;
export const COMPACTION_MEMORY_KEY_MAX_CHARS = 200;
/** Internal persisted marker rendered as an omitted-key note, never as a key. */
export const COMPACTION_MEMORY_KEYS_OMITTED_PREFIX = '__forge_omitted_memory_keys__:';

/** Persisted, host-authored action carried outside the model summary. */
export interface RecordedCompactionAction {
  kind: 'file' | 'command';
  key: string;
  outcome: 'ok' | 'failed' | 'unknown';
  line: string;
  durableEvidence?: boolean;
  toolCallId?: string;
}

/** Durable sidebar marker for one completed compaction generation. */
export interface CompactionDivider {
  generation: number;
  /** Index of the first message retained verbatim after this compaction. */
  fromIndex: number;
  /** Absent only for legacy compactions whose trigger was not persisted. */
  source?: 'auto' | 'manual';
}

export interface CompactionResumeNote {
  generation: number;
  usedTokens: number;
  /** Absent when the model has no configured window. */
  maxTokens?: number | undefined;
}

/** Short one-shot guidance for the first request after this compaction. */
export function formatCompactionResumeNote(note: CompactionResumeNote): string;
export function formatCompactionResumeNote(note: undefined): undefined;
export function formatCompactionResumeNote(
  note: CompactionResumeNote | undefined,
): string | undefined;
export function formatCompactionResumeNote(
  note: CompactionResumeNote | undefined,
): string | undefined {
  if (!note) return undefined;
  // A fixed locale: this text is frozen into the prompt.
  const size =
    note.maxTokens === undefined
      ? `, at ${note.usedTokens.toLocaleString('en-US')} tokens`
      : `, at ${note.usedTokens.toLocaleString('en-US')} of ` +
        `${note.maxTokens.toLocaleString('en-US')} tokens`;
  return (
    `Context was compacted just now (compaction ${note.generation}${size}). ` +
    'The two messages at the start replace the earlier transcript; they are a summary, ' +
    'not the full history. Start from its Next section, and check a file or result before ' +
    'relying on a part the summary marks as uncertain.'
  );
}

/**
 * Model-facing replacement context recorded by one compaction generation.
 *
 * All fields after `fromIndex` are optional so records created before the
 * structured replacement context continue to load unchanged.
 */
export interface CompactionState {
  summary: string;
  fromIndex: number;
  generation?: number;
  /** All transcript boundaries, since this state's summary replaces older ones. */
  dividers?: CompactionDivider[];
  userMessages?: string[];
  recordedActions?: RecordedCompactionAction[];
  repoState?: string;
  /** The agent's own last words before the cut. See `compactionLastReply.ts`. */
  lastReply?: string;
  /**
   * Whether tool calls ran after `lastReply` was sent.
   *
   * Without it the block asserted that nothing had happened since — false
   * whenever the agent spoke and then worked, and outranking the recorded tool
   * outcomes that are the real account of what executed.
   */
  lastReplyFollowedByTools?: boolean;
  /**
   * How many recorded actions the cap has dropped, per kind, across every
   * generation so far.
   *
   * Persisted rather than recomputed: once a list has been capped, counting it
   * again reports zero, and a resumed agent reading a short ledger cannot tell
   * a dropped entry from an action that never happened.
   */
  omittedActions?: { file: number; command: number };
  /**
   * Keys stored with `remember` when this compaction ran.
   *
   * `recall` needs a key, and after a compaction the agent no longer knows which
   * ones it stored — so the store it uses to survive compaction went unread.
   * The newest `COMPACTION_MEMORY_KEYS_MAX` only; the rendered block points at
   * `list_memories` for the rest.
   */
  memoryKeys?: string[];
  /** Cleared after this compaction is delivered to the first subsequent request. */
  resumeNote?: CompactionResumeNote;
}
