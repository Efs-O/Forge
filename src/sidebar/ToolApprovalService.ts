import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';
import {
  buildApprovalRequestMessage,
  type ToolApprovalAutoApprovedEvent,
  type ToolApprovalRequestEvent,
  type ToolApprovalResolvedEvent,
  type ToolApprovalSink,
} from './toolApprovalEvents';
import type { ApprovalDecision, ApprovalOffer } from './approvalMessages';
import type { ChatRuleApproval } from './chatApprovalRules';
import type { AlwaysApprovalWriteResult } from './approvalPolicyRules';
import { applyAlwaysProjectApproval } from './approvalProjectWriter';
import { applyChatApprovalRule } from './approvalChatWriter';
import {
  unattendedConversations,
  type UnattendedConversationRegistry,
} from './unattendedConversations';
import {
  ToolApprovalPolicyDenied,
  type ToolApprovalCallOptions,
  type ToolApprovalOutcome,
} from './toolApprovalOutcome';
import { refusalReasonForGate } from './untrustedExitPolicy';
import { ApprovalTimeoutState } from './approvalTimeoutState';
import { approvalEventForConversation } from './approvalEventLookup';
import { readClankerModeAtApproval, type ChatClankerRecords } from './chatClanker';

/**
 * The card contract lives in `toolApprovalEvents.ts` — the webview bridge, the
 * Telegram mirror and the desktop bridge read the same shapes this queue emits.
 * Re-exported so every consumer that imports them from here keeps working.
 */
export {
  buildApprovalRequestMessage,
  type ToolApprovalAutoApprovedEvent,
  type ToolApprovalRequestEvent,
  type ToolApprovalResolvedEvent,
  type ToolApprovalSink,
};
export type { ApprovalDecision, ApprovalOffer };

interface PendingApproval extends ToolApprovalRequestEvent {
  /** The card's identity and text come from the event type it extends: this adds
   *  only what the queue needs and a mirror never sees.
   */
  resolve: (outcome: ToolApprovalOutcome) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  /** The card is now waiting for the owner and has said so once. */
  waitingForOwner?: boolean;
  cardReason?: string;
}

export class ToolApprovalService {
  private readonly queue: PendingApproval[] = [];
  private active: PendingApproval | null = null;
  /** Clanker is chat-local: this read-through cache lets the queue answer without
   *  looking up a record each call and distinguish real changes. The record stays
   *  authoritative, so a tab restored from archive keeps the mode its owner armed. */
  private readonly clankerFlags = new Map<string, boolean>();
  private onApprovalStart?: (conversationId: string) => void;
  private onApprovalEnd?: (conversationId: string) => void;
  private readonly sinks = new Set<ToolApprovalSink>();
  private readonly timeouts = new ApprovalTimeoutState();

  constructor(
    private readonly post: (message: HostToWebview) => void,
    private readonly getView: () => vscode.WebviewView | undefined,
    private readonly unattended: UnattendedConversationRegistry = unattendedConversations,
    private readonly getTimeoutMinutes: () => number | undefined = () => undefined,
    /** Conversation records behind this window's chats. Read to answer for chats
     *  this queue has not seen, and written so toggles survive reloads. Absent means
     *  no records are loaded — the shape a test that arms one chat replaces. */
    private readonly chatRecords?: ChatClankerRecords,
    /** The chat rules' write half (`chatApprovalRules.ts`'s `allow`): what an
     *  "Allow for this chat" answer stores, plus the save that carries it. Absent
     *  means this window has nowhere to store a chat rule — the shape a window that
     *  has loaded no conversations has, and the shape a test that arms one replaces.
     */
    private readonly chatRuleAllow?: ChatRuleApproval['allow'],
    private readonly chatRuleAlways?: (keys: readonly string[]) => AlwaysApprovalWriteResult,
    private readonly getClankerDefaultUntil: () => string | undefined = () => undefined,
    private readonly onClankerDefaultExpired: (
      conversationId: string,
      notice: string,
    ) => void = () => undefined,
  ) {}

  addSink(sink: ToolApprovalSink): { dispose(): void } {
    this.sinks.add(sink);
    return { dispose: () => this.sinks.delete(sink) };
  }

  /** A gate call a chat rule answered with no card, forwarded to the sinks.
   *
   * The queue answers nothing here and holds nothing: no id, no timer, no
   * `requested`/`resolved` pair, and no Telegram mirror to answer. It exists so the
   * one writer of the gate ledger stays `GateEventLog`, which is already a sink —
   * `ToolDispatch` does not know a session log exists, and a second writer would be
   * a ledger that can disagree with itself.
   */
  autoApproved(event: ToolApprovalAutoApprovedEvent): void {
    for (const sink of [...this.sinks]) sink.autoApproved?.(event);
  }

  pending(): ToolApprovalRequestEvent | undefined {
    return this.active ? this.eventOf(this.active) : undefined;
  }

  pendingForConversation(id: string): ToolApprovalRequestEvent | undefined {
    return approvalEventForConversation(this.active, this.queue, id, this.eventOf.bind(this));
  }
  /** All attributed approvals, including requests queued behind the active gate. */
  pendingConversationIds(): Set<string> {
    const ids = new Set<string>();
    for (const item of [...(this.active ? [this.active] : []), ...this.queue]) {
      if (item.conversationId) ids.add(item.conversationId);
      else ids.add('');
    }
    return ids;
  }

  /** Register callbacks fired when an approval request is shown / resolved. */
  setApprovalLifecycle(
    onStart: (conversationId: string) => void,
    onEnd: (conversationId: string) => void,
  ): void {
    this.onApprovalStart = onStart;
    this.onApprovalEnd = onEnd;
  }

  /** Start a user turn and allow that conversation's next approval to wait. */
  beginTurn(conversationId: string): void {
    this.timeouts.beginTurn(conversationId);
  }

  /** Drop turn-local state when a conversation is closed or deleted. */
  clearConversationState(conversationId: string): void {
    this.timeouts.clear(conversationId);
    // The cached Clanker flag goes with it. A chat that still exists reads its own
    // record again on the next call, so this only forgets what is already forgotten;
    // a deleted chat has no record left to read, and must not answer for its id.
    this.clankerFlags.delete(conversationId);
  }

  setClankerMode(conversationId: string, enabled: boolean): void {
    const current = this.getClankerMode(conversationId);
    if (current === enabled) return;
    this.clankerFlags.set(conversationId, enabled);
    // The durable copy is the chat's own record: a toggle that lived only in this
    // map would be off again at the next reload, and the caller that owns the
    // conversation saves it, exactly as the chat-rule writes do.
    this.chatRecords?.write(conversationId, enabled);
    this.post({ type: 'clankerChanged', enabled, conversationId });
  }

  getClankerMode(conversationId: string): boolean {
    return this.chatRecords?.read(conversationId) ?? this.clankerFlags.get(conversationId) ?? false;
  }

  getClankerModeForApproval(conversationId: string): boolean {
    if (!this.chatRecords) return this.clankerFlags.get(conversationId) ?? false;
    return (
      readClankerModeAtApproval(
        this.chatRecords,
        conversationId,
        this.getClankerDefaultUntil(),
        Date.now(),
        this.clankerFlags.get(conversationId),
        this.onClankerDefaultExpired,
      ) ?? false
    );
  }

  toggleClankerMode(conversationId: string): boolean {
    const enabled = !this.getClankerMode(conversationId);
    this.setClankerMode(conversationId, enabled);
    return enabled;
  }

  request(
    toolName: string,
    detail: string,
    dangerous = false,
    conversationId?: string,
    signal?: AbortSignal,
    options?: ToolApprovalCallOptions,
  ): Promise<ToolApprovalOutcome> {
    if (signal?.aborted) return Promise.resolve('declined');
    const clankerEnabled = conversationId ? this.getClankerModeForApproval(conversationId) : false;
    if (conversationId) {
      const timedOut = this.timeouts.timedOutResult(conversationId);
      if (timedOut) return Promise.resolve(timedOut);
    }
    if (conversationId && this.unattended.has(conversationId) && options?.policyAllowPath) {
      return Promise.reject(
        new ToolApprovalPolicyDenied(toolName, {
          job: this.unattended.jobMeta(conversationId) !== undefined,
          allowPath: options.policyAllowPath,
          ...(options.policyApprovalKey ? { approvalKey: options.policyApprovalKey } : {}),
          ...(options?.cardReason ? { why: options.cardReason } : {}),
          ...(options?.alternative ? { alternative: options.alternative } : {}),
        }),
      );
    }
    /* An unattended taint gate requires an owner. Refuse before the dangerous-call
     * branch below can approve it without a card nobody is there to answer. */
    if (
      options?.gateKind === 'taintGate' &&
      conversationId &&
      this.unattended.has(conversationId)
    ) {
      return Promise.reject(
        new ToolApprovalPolicyDenied(toolName, {
          job: this.unattended.jobMeta(conversationId) !== undefined,
          why: refusalReasonForGate(conversationId, options.cardReason),
          ...(options.alternative ? { alternative: options.alternative } : {}),
        }),
      );
    }
    if (conversationId && this.unattended.has(conversationId)) {
      if (dangerous) {
        const job = this.unattended.jobMeta(conversationId) !== undefined;
        // Nothing here can answer it, so refuse at once — naming the pattern and
        // the alternative — and let the run carry on. A deny-list command
        // (`gateKind: 'denyList'`) lands here too, refused whatever an
        // automated answer would have said, with the tool it should use in
        // `options.alternative`.
        return Promise.reject(
          new ToolApprovalPolicyDenied(toolName, {
            job,
            ...(options?.cardReason ? { why: options.cardReason } : {}),
            ...(options?.alternative ? { alternative: options.alternative } : {}),
          }),
        );
      }
      return Promise.resolve('approved');
    }
    /* Clanker covers every remaining call except protected stops. Dangerous alone
     * is not a stop; the owner wall runs earlier and deny-list gates are tagged. */
    if (
      conversationId &&
      options?.clankerStop !== true &&
      options?.gateKind !== 'denyList' &&
      clankerEnabled
    ) {
      this.autoApproved({
        toolName,
        ...(detail ? { detail } : {}),
        conversationId,
        answeredBy: 'clanker',
      });
      return Promise.resolve('approved');
    }
    if (!this.getView() && this.sinks.size === 0) {
      return Promise.reject(
        new Error(`Forge: sidebar is unavailable for tool approval (${toolName}).`),
      );
    }
    return new Promise<ToolApprovalOutcome>((resolve) => {
      const timeoutMinutes = this.getTimeoutMinutes();
      // A gate no automated answer is allowed for is marked as waiting for the
      // owner when it opens, not after five minutes of waiting for something
      // that was never going to arrive.
      const ownerOnly = options?.gateKind === 'taintGate';
      const pending: PendingApproval = {
        id: `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        toolName,
        detail,
        dangerous,
        resolve,
        ...(conversationId ? { conversationId } : {}),
        ...(signal ? { signal } : {}),
        ...(ownerOnly ? { waitingForOwner: true } : {}),
        ...(options?.cardReason ? { cardReason: options.cardReason } : {}),
        ...(options?.allowForChat ? { allowForChat: options.allowForChat } : {}),
        ...(options?.alwaysInProject ? { alwaysInProject: options.alwaysInProject } : {}),
      };
      if (timeoutMinutes !== undefined) {
        pending.timer = setTimeout(
          () => this.timeout(pending, timeoutMinutes),
          timeoutMinutes * 60_000,
        );
      }
      if (signal) {
        pending.abortListener = () => this.cancel(pending.id);
        signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      this.queue.push(pending);
      if (pending.conversationId) this.onApprovalStart?.(pending.conversationId);
      this.pump();
      if (ownerOnly) this.announceWaitingForOwner(pending);
    });
  }

  /** Resolve every surface through one queue. Rule decisions store only the keys
   *  offered on this card; cancellation and timeout never store an allow. */
  resolve(id: string, decision: ApprovalDecision): void {
    const item = this.findPending(id);
    if (!item || !this.removePending(item)) return;
    // A stale or forged webview cannot turn an Approve/Decline-only card into a
    // chat-wide rule: only the offer carried by this pending card is storable.
    const answer =
      (decision === 'allowChat' && !item.allowForChat) ||
      (decision === 'alwaysProject' && !item.alwaysInProject)
        ? 'decline'
        : decision;
    let resolution:
      | {
          chatRuleErrors?: readonly string[];
          approvalNotice?: string;
        }
      | undefined;
    if (answer === 'allowChat') {
      const chatRuleErrors = this.applyChatAllow(item);
      if (chatRuleErrors) resolution = { chatRuleErrors };
    } else if (answer === 'alwaysProject') {
      resolution = applyAlwaysProjectApproval({
        offer: item.alwaysInProject,
        chatOffer: item.allowForChat,
        conversationId: item.conversationId,
        ...(this.chatRuleAlways ? { writeAlways: this.chatRuleAlways } : {}),
        ...(this.chatRuleAllow ? { allowChat: this.chatRuleAllow } : {}),
        post: this.post,
      });
    }
    this.finish(
      item,
      answer === 'decline' ? 'declined' : 'approved',
      'resolved',
      answer,
      resolution?.chatRuleErrors,
      resolution?.approvalNotice,
    );
    this.pump();
  }

  /** Store the offer this queue placed on the card, never a surface's re-derived key. */
  private applyChatAllow(item: PendingApproval): readonly string[] | undefined {
    return applyChatApprovalRule({
      offer: item.allowForChat,
      conversationId: item.conversationId,
      ...(this.chatRuleAllow ? { allow: this.chatRuleAllow } : {}),
      post: this.post,
    });
  }

  cancelConversation(conversationId?: string): void {
    const pending = [...(this.active ? [this.active] : []), ...this.queue].filter(
      (item) => !conversationId || item.conversationId === conversationId,
    );
    for (const item of pending) {
      if (this.removePending(item)) this.finish(item, 'declined', 'cancelled');
    }
    this.pump();
  }

  cancelAll(): void {
    this.cancelConversation();
  }

  dispose(): void {
    this.cancelAll();
    this.timeouts.clearAll();
    this.sinks.clear();
  }

  private cancel(id: string): void {
    const item = this.findPending(id);
    if (!item || !this.removePending(item)) return;
    this.finish(item, 'declined', 'cancelled');
    this.pump();
  }

  private timeout(item: PendingApproval, minutes: number): void {
    if (!this.removePending(item)) return;
    const conversationId = item.conversationId;
    if (conversationId) this.timeouts.record(conversationId, minutes);
    this.finish(item, { kind: 'timeout', minutes }, 'timeout');
    if (conversationId) {
      for (const queued of [...this.queue]) {
        if (queued.conversationId !== conversationId || !this.removePending(queued)) continue;
        this.finish(queued, { kind: 'timeout', minutes }, 'timeout');
      }
    }
    this.pump();
  }

  private findPending(id: string): PendingApproval | undefined {
    return this.active?.id === id ? this.active : this.queue.find((item) => item.id === id);
  }

  private removePending(item: PendingApproval): boolean {
    if (this.active?.id === item.id) this.active = null;
    else {
      const index = this.queue.findIndex((queued) => queued.id === item.id);
      if (index < 0) return false;
      this.queue.splice(index, 1);
    }
    if (item.timer !== undefined) clearTimeout(item.timer);
    if (item.signal && item.abortListener)
      item.signal.removeEventListener('abort', item.abortListener);
    if (item.conversationId) this.onApprovalEnd?.(item.conversationId);
    return true;
  }

  /** Tell every mirror, once, that only the owner can answer this card now. */
  private announceWaitingForOwner(item: PendingApproval): void {
    const event = this.eventOf(item);
    for (const sink of this.sinks) sink.waitingForOwner?.(event);
  }

  private finish(
    item: PendingApproval,
    outcome: ToolApprovalOutcome,
    reason: ToolApprovalResolvedEvent['reason'],
    decision: ApprovalDecision = 'decline',
    chatRuleErrors?: readonly string[],
    approvalNotice?: string,
  ): void {
    this.emitResolved(
      item,
      outcome === 'approved',
      reason,
      decision,
      chatRuleErrors,
      approvalNotice,
    );
    item.resolve(outcome);
  }

  private pump(): void {
    if (this.active) return;
    const next = this.queue[0];
    if (!next) return;
    if (next.signal?.aborted) {
      this.queue.shift();
      if (next.timer !== undefined) clearTimeout(next.timer);
      if (next.signal && next.abortListener)
        next.signal.removeEventListener('abort', next.abortListener);
      if (next.conversationId) this.onApprovalEnd?.(next.conversationId);
      this.emitResolved(next, false, 'cancelled', 'decline');
      next.resolve('declined');
      this.pump();
      return;
    }
    this.queue.shift();
    this.active = next;
    const event = this.eventOf(next);
    if (this.getView()) {
      void vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
      this.post(buildApprovalRequestMessage(event));
    }
    for (const sink of this.sinks) sink.requested(event);
  }

  private eventOf(item: PendingApproval): ToolApprovalRequestEvent {
    return {
      id: item.id,
      toolName: item.toolName,
      detail: item.detail,
      dangerous: item.dangerous,
      ...(item.conversationId ? { conversationId: item.conversationId } : {}),
      ...(item.waitingForOwner ? { waitingForOwner: true } : {}),
      ...(item.cardReason ? { cardReason: item.cardReason } : {}),
      // The offer travels with every announce of the card — the first `requested`,
      // the re-announce that says only the owner may answer it, and the copy the
      // mirror keeps — so a card re-posted after a webview reload still shows the
      // buttons its keys earned, and the receipt can name what was allowed.
      ...(item.allowForChat ? { allowForChat: item.allowForChat } : {}),
      ...(item.alwaysInProject ? { alwaysInProject: item.alwaysInProject } : {}),
    };
  }

  private emitResolved(
    item: PendingApproval,
    approved: boolean,
    reason: ToolApprovalResolvedEvent['reason'],
    decision: ApprovalDecision,
    chatRuleErrors?: readonly string[],
    approvalNotice?: string,
  ): void {
    const event = {
      ...this.eventOf(item),
      approved,
      decision,
      reason,
      ...(item.waitingForOwner ? { waitingForOwner: true } : {}),
      ...(chatRuleErrors ? { chatRuleErrors } : {}),
      ...(approvalNotice ? { approvalNotice } : {}),
    };
    // The webview is not a sink, so tell it separately: an approval settled from
    // a remote transport (or cancelled) must not leave live-looking buttons in
    // the sidebar for a decision that has already been made.
    if (this.getView()) this.post({ type: 'confirmResolved', id: item.id });
    for (const sink of this.sinks) sink.resolved(event);
  }
}
