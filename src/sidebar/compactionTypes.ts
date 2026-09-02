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
}
