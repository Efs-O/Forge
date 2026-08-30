import { randomBytes } from 'crypto';
import type {
  ToolApprovalRequestEvent,
  ToolApprovalResolvedEvent,
} from '../sidebar/ToolApprovalService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundEvent } from './types';

interface RemoteApprovalEntry {
  requestId: string;
  chatId: string;
  event: ToolApprovalRequestEvent;
  nonce?: string;
  actionId?: string;
  resolving?: boolean;
}

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
    this.approvals.set(event.id, { requestId: request.id, chatId: request.chatId, event });
    void this.publish(event.id);
  }

  private onResolved(event: ToolApprovalResolvedEvent): void {
    const pending = this.approvals.get(event.id);
    if (!pending) return;
    this.approvals.delete(event.id);
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
