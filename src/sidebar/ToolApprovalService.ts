import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';
import {
  unattendedConversations,
  type UnattendedConversationRegistry,
} from './unattendedConversations';

export interface ToolApprovalRequestEvent {
  id: string;
  toolName: string;
  detail: string;
  dangerous: boolean;
  conversationId?: string;
}

/** The one host-to-webview representation used for live and re-posted approvals. */
export function buildApprovalRequestMessage(event: ToolApprovalRequestEvent): HostToWebview {
  return {
    type: 'confirmRequest',
    id: event.id,
    toolName: event.toolName,
    detail: event.detail,
    ...(event.dangerous ? { isDangerous: true } : {}),
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
  };
}

export interface ToolApprovalResolvedEvent extends ToolApprovalRequestEvent {
  approved: boolean;
  reason: 'resolved' | 'cancelled' | 'timeout';
}

export type ToolApprovalOutcome = 'approved' | 'declined' | { kind: 'timeout'; minutes: number };

/** Format a declined or timed-out approval for the model's tool-result row. */
export function toolApprovalResult(
  toolName: string,
  outcome: Exclude<ToolApprovalOutcome, 'approved'>,
  declineHint?: string,
): string {
  const result =
    typeof outcome === 'string'
      ? `User declined: ${toolName}`
      : `Not run: nobody answered the approval for ${toolName} within ${outcome.minutes} min. ` +
        'Do not retry it this turn. Finish the remaining steps, then list this one as not done in your final reply.';
  return declineHint ? `${result} — use this instead: ${declineHint}` : result;
}

export interface ToolApprovalSink {
  requested(event: ToolApprovalRequestEvent): void;
  resolved(event: ToolApprovalResolvedEvent): void;
}

/** A tool was refused by unattended policy, rather than by a human. */
export class ToolApprovalPolicyDenied extends Error {
  /** `job` is false for an unattended bus turn, which has no RESULT contract. */
  constructor(toolName: string, job = true) {
    super(
      `unattended: dangerous tool denied by policy: "${toolName}". ` +
        (job
          ? 'Stop and report RESULT: failed naming the action you needed.'
          : 'Nobody is present to approve it, so do not retry it. Recycle-bin deletes are allowed; ' +
            'only a permanent delete (to_trash: false) is dangerous. Continue with safe steps or ' +
            'report the step as not done.'),
    );
    this.name = 'ToolApprovalPolicyDenied';
  }
}

interface PendingApproval extends ToolApprovalRequestEvent {
  id: string;
  toolName: string;
  detail: string;
  dangerous: boolean;
  conversationId?: string;
  resolve: (outcome: ToolApprovalOutcome) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ToolApprovalService {
  private readonly queue: PendingApproval[] = [];
  private active: PendingApproval | null = null;
  private clankerMode = false;
  private onApprovalStart?: (conversationId: string) => void;
  private onApprovalEnd?: (conversationId: string) => void;
  private readonly sinks = new Set<ToolApprovalSink>();
  private readonly timedOutConversations = new Set<string>();
  private readonly timeoutMinutesByConversation = new Map<string, number>();

  constructor(
    private readonly post: (message: HostToWebview) => void,
    private readonly getView: () => vscode.WebviewView | undefined,
    private readonly unattended: UnattendedConversationRegistry = unattendedConversations,
    private readonly getTimeoutMinutes: () => number | undefined = () => undefined,
  ) {}

  addSink(sink: ToolApprovalSink): { dispose(): void } {
    this.sinks.add(sink);
    return { dispose: () => this.sinks.delete(sink) };
  }

  pending(): ToolApprovalRequestEvent | undefined {
    return this.active ? this.eventOf(this.active) : undefined;
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
    this.timedOutConversations.delete(conversationId);
    this.timeoutMinutesByConversation.delete(conversationId);
  }

  /** Drop turn-local state when a conversation is closed or deleted. */
  clearConversationState(conversationId: string): void {
    this.timedOutConversations.delete(conversationId);
    this.timeoutMinutesByConversation.delete(conversationId);
  }

  /**
   * Sole writer of the flag. It always announces the new value to the webview:
   * a remote `/clanker` changes the same gate the sidebar composer advertises,
   * and a banner that still reads "gated" while writes land unconfirmed is the
   * worse half of the bug.
   */
  setClankerMode(enabled: boolean): void {
    if (this.clankerMode === enabled) return;
    this.clankerMode = enabled;
    this.post({ type: 'clankerChanged', enabled });
  }

  getClankerMode(): boolean {
    return this.clankerMode;
  }

  toggleClankerMode(): boolean {
    this.setClankerMode(!this.clankerMode);
    return this.clankerMode;
  }

  request(
    toolName: string,
    detail: string,
    dangerous = false,
    conversationId?: string,
    signal?: AbortSignal,
  ): Promise<ToolApprovalOutcome> {
    if (signal?.aborted) return Promise.resolve('declined');
    if (conversationId && this.timedOutConversations.has(conversationId)) {
      return Promise.resolve({
        kind: 'timeout',
        minutes: this.timeoutMinutesByConversation.get(conversationId)!,
      });
    }
    if (conversationId && this.unattended.has(conversationId)) {
      if (dangerous) {
        const job = this.unattended.jobMeta(conversationId) !== undefined;
        return Promise.reject(new ToolApprovalPolicyDenied(toolName, job));
      }
      return Promise.resolve('approved');
    }
    if (this.clankerMode && !dangerous) return Promise.resolve('approved');
    if (!this.getView() && this.sinks.size === 0) {
      return Promise.reject(
        new Error(`Forge: sidebar is unavailable for tool approval (${toolName}).`),
      );
    }
    return new Promise<ToolApprovalOutcome>((resolve) => {
      const timeoutMinutes = this.getTimeoutMinutes();
      const pending: PendingApproval = {
        id: `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        toolName,
        detail,
        dangerous,
        resolve,
        ...(conversationId ? { conversationId } : {}),
        ...(signal ? { signal } : {}),
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
    });
  }

  resolve(id: string, approved: boolean): void {
    const item = this.findPending(id);
    if (!item || !this.removePending(item)) return;
    this.finish(item, approved ? 'approved' : 'declined', 'resolved');
    this.pump();
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
    this.timedOutConversations.clear();
    this.timeoutMinutesByConversation.clear();
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
    if (conversationId) {
      this.timedOutConversations.add(conversationId);
      this.timeoutMinutesByConversation.set(conversationId, minutes);
    }
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

  private finish(
    item: PendingApproval,
    outcome: ToolApprovalOutcome,
    reason: ToolApprovalResolvedEvent['reason'],
  ): void {
    this.emitResolved(item, outcome === 'approved', reason);
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
      this.emitResolved(next, false, 'cancelled');
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
    };
  }

  private emitResolved(
    item: PendingApproval,
    approved: boolean,
    reason: ToolApprovalResolvedEvent['reason'],
  ): void {
    const event = { ...this.eventOf(item), approved, reason };
    // The webview is not a sink, so tell it separately: an approval settled from
    // a remote transport (or cancelled) must not leave live-looking buttons in
    // the sidebar for a decision that has already been made.
    if (this.getView()) this.post({ type: 'confirmResolved', id: item.id });
    for (const sink of this.sinks) sink.resolved(event);
  }
}
