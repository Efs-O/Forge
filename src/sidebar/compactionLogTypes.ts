/** One completed compaction, as recorded in the session transcript. */
export interface CompactionLogEntry {
  /** How many times this conversation has been compacted, including this one. */
  generation: number;
  /** Index into `conv.messages` from which the model still sees real turns. */
  fromIndex: number;
  /** Exact server-reported context at the moment of the cut, prompt + completion. */
  usedTokens: number;
  /** Per-slot window, 0 when the model has no configured context. */
  maxTokens: number;
  /** Size of the summary that replaced the cut turns. */
  summaryChars: number;
  /** The summary text itself, retained as the agent's working context. */
  summary: string;
  /** Which path started this compaction. */
  trigger: string;
  /** Configured `auto_compact.at` when the event fired; absent when unset. */
  threshold?: number;
}

export interface CompactionAttemptLogEntry {
  /** Shared by the start row and its terminal row; an unmatched start means a crash. */
  attemptId: string;
  phase: 'start' | 'finished' | 'suppressed';
  trigger: string;
  outcome?: string;
  /** CompactionFailureCategory, on a failed attempt or the category behind a suppression. */
  category?: string;
  finishReason?: string;
  calls?: number;
  usedTokens: number;
  maxTokens: number;
  /** Forecast tokens compared with auto_compact.at by a mid-turn check. */
  decisionTokens?: number;
  /** Estimated characters of the window being compacted (known at start). */
  windowChars?: number;
  /** Estimated characters of the replacement window; unknown until a candidate exists. */
  candidateChars?: number;
  hostChars?: number;
  hostMaxChars?: number;
  charsPerToken?: number;
  counter?: 'tokenize' | 'count_tokens' | 'estimate';
  components?: Record<string, number>;
  shed?: string[];
  /** The attempt succeeded or failed on its single floor-mode retry. */
  floorMode?: boolean;
  /** The summary was cut off by the output cap and its complete part kept. */
  salvagedFromLength?: boolean;
  invalidSummary?: import('./compactionFailure').InvalidSummaryDetail;
}
