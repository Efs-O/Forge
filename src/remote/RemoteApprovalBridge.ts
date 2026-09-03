import { randomBytes } from 'crypto';
import type {
  ToolApprovalRequestEvent,
  ToolApprovalResolvedEvent,
} from '../sidebar/ToolApprovalService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundEvent } from './types';
import type { PendingGate } from '../voice/VoiceGrammar';

interface RemoteApprovalEntry {
  requestId: string;
  chatId: string;
  event: ToolApprovalRequestEvent;
  nonce?: string;
  actionId?: string;
  resolving?: boolean;
  /** When the gate opened. Half of the §22A R1 recording-window rule. */
  openedAt: number;
}

/**
 * How long a resolved gate is remembered after it leaves `approvals`.
 *
 * `correlateGate` refuses when a gate opened OR CLOSED inside the recording
 * window, and a gate that closed is deleted immediately -- so without this the
 * ambiguous case would be indistinguishable from no gate at all, and a late
 * "approve" would silently land on whatever opened next. Longer than any
 * plausible voice note; the list is pruned on every read.
 */
const RESOLVED_MEMORY_MS = 5 * 60_000;

/**
 * Provider-facing approval handles must stay short. Telegram limits callback
 * data to 64 UTF-8 bytes, while a Forge approval id plus the auth-session UUID
 * already exceeds that limit. The nonce remains server-side in the entry; an
 * opaque handle is sufficient to find it and does not expose authorization
 * state to the transport.
 */
function newActionId(): string {
  return randomBytes(18).toString('base64url');
}

/** Auth-nonce-bound remote presentation for Forge's one approval queue. */
export class RemoteApprovalBridge {
  private readonly approvals = new Map<string, RemoteApprovalEntry>();
  /** Gates that closed recently, so a spoken command can detect the race. */
  private resolvedGates: Array<{
    id: string;
    chatId: string;
    openedAt: number;
    resolvedAt: number;
  }> = [];
  private subscription: { dispose(): void } | undefined;

  constructor(
    private readonly channel: RemoteChannel,
    private readonly store: RemoteRequestStore,
    private readonly auth: RemoteAuth,
    private readonly host: ForgeHostFacade,
    private readonly signal: AbortSignal,
    private maxMessageChars: number,
    private readonly onError?: (message: string) => void,
  ) {}

  start(): void {
    this.subscription = this.host.addApprovalSink({
      requested: (event) => this.onRequested(event),
      resolved: (event) => this.onResolved(event),
    });
  }

  stop(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
    this.approvals.clear();
  }

  updateMaxMessageChars(maxMessageChars: number): void {
    this.maxMessageChars = maxMessageChars;
  }

  resolveAction(
    event: Extract<RemoteInboundEvent, { kind: 'action' }>,
    nonce: string | undefined,
  ): boolean {
    const pending = [...this.approvals.values()].find(
      (approval) => approval.actionId === event.correlationId,
    );
    if (
      !pending ||
      pending.chatId !== event.chatId ||
      pending.resolving ||
      pending.nonce !== nonce
    ) {
      return false;
    }
    pending.resolving = true;
    this.host.resolveApproval(pending.event.id, event.action === 'approve');
    return true;
  }

  /**
   * Every gate a spoken command could plausibly refer to, open or recently
   * closed, for `correlateGate` to judge (§22A R1-revised).
   *
   * Recently-closed gates are included deliberately: they are what turns "one
   * gate was open the whole time" into a checkable claim rather than an
   * assumption about a Map that may have changed underneath it.
   */
  pendingGates(chatId: string, now = Date.now()): PendingGate[] {
    this.resolvedGates = this.resolvedGates.filter(
      (gate) => now - gate.resolvedAt < RESOLVED_MEMORY_MS,
    );
    const open = [...this.approvals.entries()]
      .filter(([, approval]) => approval.chatId === chatId && !approval.resolving)
      .map(([id, approval]) => ({ id, chatId: approval.chatId, openedAt: approval.openedAt }));
    const closed = this.resolvedGates
      .filter((gate) => gate.chatId === chatId)
      .map((gate) => ({ ...gate }));
    return [...open, ...closed];
  }

  /**
   * Resolves a gate a spoken word selected, having already been correlated.
   *
   * Separate from `resolveAction` because the two carry different evidence: the
   * button path has an `actionId` the transport echoed back, while this path has
   * only a recording window. Both still check `chatId` and the auth nonce, so
   * the spoken route is strictly narrower than the button it substitutes for --
   * it can never resolve a gate the button could not.
   */
  resolveSpoken(
    gateId: string,
    approve: boolean,
    chatId: string,
    nonce: string | undefined,
  ): boolean {
    const pending = this.approvals.get(gateId);
    if (!pending || pending.chatId !== chatId || pending.resolving || pending.nonce !== nonce) {
      return false;
    }
    pending.resolving = true;
    this.host.resolveApproval(pending.event.id, approve);
    return true;
  }

  republish(chatId: string): void {
    for (const [id, approval] of this.approvals) {
      if (!approval.resolving && approval.chatId === chatId) void this.publish(id);
    }
  }

  private onRequested(event: ToolApprovalRequestEvent): void {
    if (!event.conversationId) return;
    const chain = this.host
      .status()
      .requestChains.find((item) => item.conversationId === event.conversationId);
    if (!chain?.remoteRequestId) return;
    const request = this.store.getRequest(chain.remoteRequestId);
    if (!request || request.channel !== this.channel.name) return;
    this.approvals.set(event.id, {
      requestId: request.id,
      chatId: request.chatId,
      event,
      openedAt: Date.now(),
    });
    void this.publish(event.id);
  }

  private onResolved(event: ToolApprovalResolvedEvent): void {
    const pending = this.approvals.get(event.id);
    if (!pending) return;
    this.approvals.delete(event.id);
    this.resolvedGates.push({
      id: event.id,
      chatId: pending.chatId,
      openedAt: pending.openedAt,
      resolvedAt: Date.now(),
    });
    void this.publishResolution(pending, event);
  }

  private async publish(id: string): Promise<void> {
    const pending = this.approvals.get(id);
    if (!pending || pending.resolving) return;
    if (!(await this.auth.canDeliver(this.channel.name, pending.chatId))) return;
    const nonce = await this.auth.approvalNonce(this.channel.name, pending.chatId);
    if (nonce) pending.nonce = nonce;
    else delete pending.nonce;
    pending.actionId = newActionId();
    const danger = pending.event.dangerous ? ' DANGEROUS' : '';
    try {
      await this.channel.send(
        pending.chatId,
        `Forge approval${danger}: ${pending.event.toolName}\n${pending.event.detail}`.slice(
          0,
          this.maxMessageChars,
        ),
        { correlationId: pending.actionId, signal: this.signal },
      );
    } catch (err) {
      this.onError?.(
        `Forge remote approval delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async publishResolution(
    pending: RemoteApprovalEntry,
    event: ToolApprovalResolvedEvent,
  ): Promise<void> {
    if (!(await this.auth.canDeliver(this.channel.name, pending.chatId))) return;
    await this.channel
      .retractPrompt?.(pending.chatId, pending.actionId ?? event.id, this.signal)
      .catch(() => undefined);
    try {
      await this.channel.send(
        pending.chatId,
        `Forge approval ${event.approved ? 'approved' : 'denied'} (${event.reason}).`,
        { signal: this.signal },
      );
    } catch (err) {
      this.onError?.(
        `Forge remote approval update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
