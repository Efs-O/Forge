/**
 * The conversation eviction gate: which signals pin a chat open, and the
 * label each one gives a refusal. Pure — `sidebarWiring` gathers the signals,
 * this file alone decides what they mean.
 */

export interface ConversationEvictionSignals {
  streaming: boolean;
  activeRequestChain: boolean;
  unattended: boolean;
  pendingApprovalActive: boolean;
  pendingApprovalQueued: boolean;
  pendingQuestion: boolean;
  unattributedRequest: boolean;
  hostQueue: boolean | undefined;
  webviewQueue: boolean;
  beforeWebviewQueueReport: boolean;
  remoteRuntimeUnavailable: boolean;
  remoteBinding: boolean;
  remoteIntakeQueue: boolean;
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
  unattended: 'running unattended',
  pendingApprovalActive: 'waiting on a tool approval',
  pendingApprovalQueued: 'waiting on a tool approval',
  pendingQuestion: 'waiting on a question',
  unattributedRequest: 'holding an unattributed request',
  hostQueue: 'with messages queued',
  webviewQueue: 'with messages queued',
  beforeWebviewQueueReport: 'not yet reporting a queue',
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
