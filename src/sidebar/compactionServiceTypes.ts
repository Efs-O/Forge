import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { CompactionFailureCategory } from './compactionFailure';
import type { PromptRunOptions } from './PromptRun';
import type { CompactionLogEntry } from './SessionLogger';

export interface CompactionDeps {
  post: (msg: HostToWebview) => void;
  getConversation: (conversationId: string) => ConversationRuntime | undefined;
  persistSession: () => void;
  postSessionSync: () => void;
  invalidateExactTokenBudget: (conv: ConversationRuntime) => void;
  postTokenBudget: (conv: ConversationRuntime) => void;
  /**
   * Records the completed compaction on the session transcript.
   *
   * Optional: sidebar-only callers and tests omit it, and a compaction must
   * never fail because nothing is listening. `usedTokens` has to be read before
   * `invalidateExactTokenBudget` clears the counters, so the reading happens at
   * the call site rather than inside the sink.
   */
  logCompaction?: (conv: ConversationRuntime, entry: CompactionLogEntry) => void;
  /** Per-slot window and the configured auto-compaction threshold, for the log row. */
  compactionMetrics?: (conv: ConversationRuntime) => {
    max: number;
    threshold?: number;
    reasoningReserve?: number;
    outputLimitTokens?: number;
  };
  runPromptToMarkdown: (
    text: string,
    conversationId?: string,
    options?: PromptRunOptions,
  ) => Promise<string>;
  isStreaming: (conversationId: string) => boolean;
  /** Marks the conversation busy for the duration of the summarization call.
   *  Returns the release. */
  beginCompaction: (convId: string) => () => void;
  /**
   * Working-tree state to append to the summary, so a resumed agent can check
   * the recorded ledger against the repo without spending a tool call.
   *
   * Injected rather than imported so the git/process dependency stays out of
   * this file's tests, and optional so a caller that cannot supply one still
   * compacts — the block is evidence, never a precondition.
   */
  snapshotRepoState?: () => Promise<string>;
  /** Keys stored with `remember`, listed after the cut so `recall` has one to ask for. */
  listMemoryKeys?: () => readonly string[];
  /**
   * Host-originated compaction progress, consumed by the remote layer so a
   * Telegram/WhatsApp user sees "compacting…" for work they did not start.
   * Optional: sidebar-only callers (and tests) omit it.
   */
  emitCompactionEvent?: (event: CompactionEvent) => void;
}

export type CompactionTrigger = 'auto' | 'sidebar' | 'remote';

export interface CompactionEvent {
  conversationId: string;
  phase: 'started' | 'finished';
  /** Set on 'finished' only — the true terminal outcome. */
  outcome?: CompactionOutcome;
  /** Which path started this compaction; drives remote delivery policy. */
  trigger: CompactionTrigger;
  /** Set when trigger === 'remote' so the origin chat is identifiable. */
  remoteOrigin?: { channel: string; chatId: string };
}

export type CompactionOutcome = 'compacted' | 'skipped' | 'failed';

export interface CompactionOptions {
  auto: boolean;
  trigger?: CompactionTrigger;
  remoteOrigin?: { channel: string; chatId: string };
  /**
   * Called by the tool loop between two rounds of a turn that is still
   * running. The turn owns the streaming state, so this skips the streaming
   * guard, `beginCompaction` (whose release would clear the TURN's streaming
   * flag) and the generationStarted/done posts (which would end its bubble).
   */
  midTurn?: boolean;
  /** Internal policy signal shared with the attempt hold and durable diagnostics. */
  onFailureCategory?: (category: CompactionFailureCategory) => void;
}
