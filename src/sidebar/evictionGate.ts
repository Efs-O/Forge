/**
 * The conversation eviction gate: which signals pin a chat open, and the
 * label each one gives a refusal. Pure — `sidebarWiring` gathers the signals,
 * this file alone decides what they mean.
 */

export interface ConversationEvictionSignals {
  streaming: boolean;
  activeRequestChain: boolean;
  workerChatActive: boolean;
  unattended: boolean;
  /** An ask_agent reply is on its way; archiving the chat would drop it. */
  agentAskPending: boolean;
  pendingApprovalActive: boolean;
  pendingApprovalQueued: boolean;
  pendingQuestion: boolean;
  unattributedRequest: boolean;
  hostQueue: boolean | undefined;
  webviewQueue: boolean;
  /** A draft or staged attachment belongs to this conversation. */
  webviewDraft: boolean;
  beforeWebviewQueueReport: boolean;
  beforeWebviewDraftReport: boolean;
  remoteRuntimeUnavailable: boolean;
  remoteBinding: boolean;
  remoteIntakeQueue: boolean;
}

/**
 * What the host knows about prompts queued in the sidebar webview. The queue
 * is unpersisted React state, so with no view resolved (a headless window
 * after reload, or after the view is disposed) it is known empty. Only a view
 * that exists but has not reported yet is unknown — reading the no-view state
 * as unknown too pinned every chat and refused every `say --new` at the cap.
 */
export class WebviewQueueState {
  private ids: ReadonlySet<string> | undefined = new Set();
  private draftIds: ReadonlySet<string> | undefined = new Set();

  viewResolved(): void {
    this.ids = undefined;
    this.draftIds = undefined;
  }

  viewDisposed(): void {
    this.ids = new Set();
    this.draftIds = new Set();
  }

  report(ids: readonly string[]): void {
    this.ids = new Set(ids);
  }

  reportDrafts(ids: readonly string[]): void {
    this.draftIds = new Set(ids);
  }

  /** `undefined` while a resolved view has not reported. */
  isQueued(id: string): boolean | undefined {
    return this.ids?.has(id);
  }

  isDraftBearing(id: string): boolean | undefined {
    return this.draftIds?.has(id);
  }

  hasUnreportedRetentionState(): boolean {
    return this.ids === undefined || this.draftIds === undefined;
  }
}

export function isConversationEvictable(signals: ConversationEvictionSignals): boolean {
  return !Object.values(signals).some((signal) => signal === true || signal === undefined);
}

/**
 * Why each signal blocks, phrased to follow a count ("7 running a turn").
 * `Record<keyof …>` makes a signal added to the gate without a label a
 * compile error, so the explanation cannot drift from the gate.
 */
const EVICTION_BLOCKER_LABELS: Record<keyof ConversationEvictionSignals, string> = {
  streaming: 'running a turn',
  activeRequestChain: 'mid-request',
  workerChatActive: 'waiting on a worker chat it opened',
  unattended: 'running unattended',
  agentAskPending: 'waiting on an agent reply',
  pendingApprovalActive: 'waiting on a tool approval',
  pendingApprovalQueued: 'waiting on a tool approval',
  pendingQuestion: 'waiting on a question',
  unattributedRequest: 'holding an unattributed request',
  hostQueue: 'with messages queued',
  webviewQueue: 'with messages queued',
  webviewDraft: 'with a draft or attachment',
  beforeWebviewQueueReport: 'not yet reporting a queue',
  beforeWebviewDraftReport: 'not yet reporting drafts',
  remoteRuntimeUnavailable: 'with an unreachable remote runtime',
  remoteBinding: 'bound to a remote chat',
  remoteIntakeQueue: 'with remote messages queued',
};

/**
 * The remote runtime's answer as gate signals. `blocks` means "pinned", so an
 * unbound chat (`false`) must contribute no blocker, and a store still loading
 * (`undefined`) must fail closed.
 */
export function remoteEvictionSignals(
  blocks: boolean | undefined,
): Pick<
  ConversationEvictionSignals,
  'remoteRuntimeUnavailable' | 'remoteBinding' | 'remoteIntakeQueue'
> {
  return {
    remoteRuntimeUnavailable: blocks === undefined,
    remoteBinding: blocks === true,
    remoteIntakeQueue: blocks === true,
  };
}

/**
 * The labels for every signal that blocks, deduped, in gate order.
 *
 * Derived from the same signal object as `isConversationEvictable` rather than
 * a second enumeration of "reasons", so a refusal can name what actually
 * blocked. A chat with a Keep/Undo still undecided is NOT in this list: an
 * archived chat keeps its checkpoint stack, so there is nothing to warn about.
 */
export function evictionBlockers(signals: ConversationEvictionSignals): string[] {
  const labels: string[] = [];
  for (const key of Object.keys(EVICTION_BLOCKER_LABELS) as (keyof ConversationEvictionSignals)[]) {
    if (signals[key] !== true && signals[key] !== undefined) continue;
    const label = EVICTION_BLOCKER_LABELS[key];
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** Retention treats initial webview hydration as unknown, not as new activity. */
export function retentionBlockState(
  signals: ConversationEvictionSignals,
): 'clear' | 'blocked' | 'unknown' {
  const unknown = signals.beforeWebviewQueueReport || signals.beforeWebviewDraftReport;
  const blocked = Object.entries(signals).some(
    ([key, value]) =>
      key !== 'beforeWebviewQueueReport' &&
      key !== 'beforeWebviewDraftReport' &&
      (value === true || value === undefined),
  );
  return blocked ? 'blocked' : unknown ? 'unknown' : 'clear';
}
