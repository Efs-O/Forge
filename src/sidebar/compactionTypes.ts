export const RECORDED_ACTION_MAX_PER_KIND = 24;
export const RECORDED_ACTION_MAX_ITEMS = RECORDED_ACTION_MAX_PER_KIND * 2;
export const RECORDED_ACTION_KEY_MAX_CHARS = 300;
export const RECORDED_ACTION_LINE_MAX_CHARS = 800;
export const COMPACTION_REPO_STATE_MAX_CHARS = 2000;

/** Persisted, host-authored action carried outside the model summary. */
export interface RecordedCompactionAction {
  kind: 'file' | 'command';
  key: string;
  outcome: 'ok' | 'failed' | 'unknown';
  line: string;
  durableEvidence?: boolean;
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
}
