import { randomBytes } from 'crypto';
import type {
  ToolApprovalRequestEvent,
  ToolApprovalResolvedEvent,
} from '../sidebar/ToolApprovalService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { CommandCleanupScheduler } from './CommandCleanupScheduler';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundEvent } from './types';
import type { RemoteWaitFooter } from './RemoteAgentProgress';
import type { PendingGate } from '../voice/VoiceGrammar';
import { formatApprovalPrompt, waitingForOwnerLine } from './RemoteApprovalMessages';

interface RemoteApprovalEntry {
  chatId: string;
  event: ToolApprovalRequestEvent;
  nonce?: string;
  actionId?: string;
  resolving?: boolean;
  /** The messages that showed the gate; a voice reply to one resolves it. */
  messageIds?: string[];
  /**
   * The one message per publish that actually carries the Approve/Deny keyboard.
   *
   * `messageIds` records every chunk of every republished prompt, but only the
   * first chunk of a send gets buttons, and `promptMessages` on the transport
   * only remembers the most recent correlation id. Resolving a gate therefore
   * has to know each keyboard-bearing message it ever put up, or a republished
   * prompt leaves a live Approve button behind.
   */
  keyboardMessageIds?: string[];
  /**
   * The "only you can answer this" line has been sent for this gate. Written
   * before the send, so the two paths that can raise it -- a `requested` for a
   * card that opens already waiting, and the `waitingForOwner` sink -- cannot
   * both post it, whichever one arrives first.
   */
  waitingNoticeSent?: boolean;
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
  /**
   * Who owns the turn's `Forge: working…` line, so a card the owner has to
   * answer can take it off the bubble above the Approve/Deny row and put it
   * back below the decision receipt. `start()` sets it; without it (a rig, or a
   * transport with no progress bubble) the bridge changes nothing about the chat.
   */
  private workingLine: RemoteWaitFooter | undefined;

  constructor(
    private readonly channel: RemoteChannel,
    private readonly store: RemoteRequestStore,
    private readonly auth: RemoteAuth,
    private readonly host: ForgeHostFacade,
    private readonly signal: AbortSignal,
    private maxMessageChars: number,
    private readonly onError?: (message: string) => void,
    /** Deletes a routine receipt after the command-reply delay; absent in rigs = kept. */
    private readonly cleanup?: CommandCleanupScheduler,
  ) {}

  /**
   * Starts rendering gates, and takes the owner of the turn's working line.
   *
   * An approval card is an owner wait like a question board: the turn stops
   * until somebody answers it, and the card lands below the bubble carrying
   * `Forge: working…`, so that line would sit above the Approve/Deny row and
   * only ever be edited in place afterwards.
   */
  start(workingLine: RemoteWaitFooter): void {
    this.workingLine = workingLine;
    this.subscription = this.host.addApprovalSink({
      requested: (event) => this.onRequested(event),
      resolved: (event) => this.onResolved(event),
      waitingForOwner: (event) => this.onWaitingForOwner(event),
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
    this.host.resolveApproval(
      pending.event.id,
      event.action === 'approve'
        ? 'approve'
        : event.action === 'deny'
          ? 'decline'
          : event.action === 'allow_chat'
            ? 'allowChat'
            : 'alwaysProject',
      'telegram',
    );
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
      .map(([id, approval]) => ({
        id,
        chatId: approval.chatId,
        openedAt: approval.openedAt,
        ...(approval.messageIds ? { messageIds: approval.messageIds } : {}),
      }));
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
    this.host.resolveApproval(pending.event.id, approve ? 'approve' : 'decline', 'voice');
    return true;
  }

  republish(chatId: string): void {
    for (const [id, approval] of this.approvals) {
      if (!approval.resolving && approval.chatId === chatId)
        void this.publish(id).catch((err: unknown) => this.report('approval publish', err));
    }
  }

  private onRequested(event: ToolApprovalRequestEvent): void {
    if (!event.conversationId) return;
    const chatId = this.chatFor(event.conversationId);
    if (!chatId) return;
    const existing = this.approvals.get(event.id);
    if (existing && !existing.resolving) {
      // The same gate, re-announced because nobody but the owner can answer it
      // now. Keep the entry -- its openedAt is half of the §22A R1 recording
      // window, and its keyboardMessageIds are the only memory of every
      // Approve button this gate has ever put up. A fresh entry would forget
      // them and leave the older buttons live for a decision already made.
      existing.event = event;
      // A re-announce that says only the owner can answer it gets one plain
      // line, not a second card. The card it was re-posting is still on screen
      // with its Approve/Deny row live, so a second card would be a second
      // keyboard for one decision -- and the "Waiting for you." sentence has
      // to come from outside the detail, which is the part a long card gets
      // clipped to the transport's limit first.
      if (event.waitingForOwner) {
        void this.publishWaitingForOwner(event.id).catch((err: unknown) =>
          this.report('approval waiting notice', err),
        );
        return;
      }
      void this.publish(event.id).catch((err: unknown) => this.report('approval publish', err));
      return;
    }
    this.approvals.set(event.id, { chatId, event, openedAt: Date.now() });
    void this.publish(event.id).catch((err: unknown) => this.report('approval publish', err));
  }

  /**
   * The gate is waiting for a person, and for nothing else: the card is one
   *  no automated answer is allowed for.
   *
   * `requested` fires first in both cases, and for a card that opens already
   * waiting it carries the same flag, so the card and this line come out of
   * one entry and `waitingNoticeSent` makes the line exactly-once whichever of
   * the two paths raises it. No entry means no chat was ever asked about this
   * gate, so there is nobody to tell.
   */
  private onWaitingForOwner(event: ToolApprovalRequestEvent): void {
    if (!this.approvals.get(event.id)) return;
    void this.publishWaitingForOwner(event.id).catch((err: unknown) =>
      this.report('approval waiting notice', err),
    );
  }

  /**
   * Which chat is asked to open this gate.
   *
   * The queued request first, so a chat that asked for the turn is the one
   * answering for it even if a second chat is bound to the conversation. The
   * binding is the fallback, and it is what makes a gate reachable at all for
   * a turn started in the sidebar: that turn has no remote request behind it,
   * so this used to return nothing and the phone was never told the work had
   * stopped on a confirmation the user had walked away from.
   */
  private chatFor(conversationId: string): string | undefined {
    const chain = this.host
      .status()
      .requestChains.find((item) => item.conversationId === conversationId);
    const request = chain?.remoteRequestId
      ? this.store.getRequest(chain.remoteRequestId)
      : undefined;
    if (request) return request.channel === this.channel.name ? request.chatId : undefined;
    return this.store.bindingsForConversation(conversationId, this.channel.name)[0]?.chatId;
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
    // The receipt for the decision goes first, then the working line reopens
    // below it: it has to be the last thing on screen, not between the card and
    // its receipt.
    void this.publishResolution(pending, event)
      .then(() => {
        if (pending.event.conversationId)
          this.workingLine?.resumeFooter(pending.event.conversationId);
      })
      .catch((err: unknown) =>
        this.onError?.(
          `Forge remote approval resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  private async publish(id: string): Promise<void> {
    const pending = this.approvals.get(id);
    if (!pending || pending.resolving) return;
    if (!(await this.auth.canDeliver(this.channel.name, pending.chatId))) return;
    const nonce = await this.auth.approvalNonce(this.channel.name, pending.chatId);
    if (nonce) pending.nonce = nonce;
    else delete pending.nonce;
    pending.actionId = newActionId();
    try {
      const sent = await this.channel.send(
        pending.chatId,
        formatApprovalPrompt(
          pending.event,
          this.maxMessageChars,
          this.channel.parseMode === 'HTML',
        ),
        {
          correlationId: pending.actionId,
          ...(pending.event.allowForChat ? { approvalAllowChat: true } : {}),
          ...(pending.event.alwaysInProject ? { approvalAlwaysInProject: true } : {}),
          signal: this.signal,
          ...(this.channel.parseMode ? { parseMode: this.channel.parseMode } : {}),
        },
      );
      // A republish shows the gate again; a reply to either message names it.
      if (sent) {
        pending.messageIds = [...(pending.messageIds ?? []), ...sent];
        // Only the first chunk of a send carries the keyboard.
        if (sent[0]) pending.keyboardMessageIds = [...(pending.keyboardMessageIds ?? []), sent[0]];
        // The card is on screen and the turn is stopped on it: the working line
        // above it has to come off, and reopen below the decision receipt.
        if (pending.event.conversationId)
          this.workingLine?.suspendFooter(pending.event.conversationId);
      }
    } catch (err) {
      this.onError?.(
        `Forge remote approval delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The one message for a gate only the owner can answer: a plain line, with no
   * keyboard of its own, sent at most once per gate.
   *
   * No `correlationId` is what keeps it from being a second decision surface --
   * the transport hangs an Approve/Deny row on any message that carries one --
   * so the card this gate already put up stays the thing the owner answers, and
   * `resolveAction` still matches the actionId that card was sent with.
   */
  private async publishWaitingForOwner(id: string): Promise<void> {
    const pending = this.approvals.get(id);
    if (!pending || pending.resolving || pending.waitingNoticeSent) return;
    pending.waitingNoticeSent = true;
    if (!(await this.auth.canDeliver(this.channel.name, pending.chatId))) return;
    try {
      const sent = await this.channel.send(pending.chatId, waitingForOwnerLine(pending.event), {
        signal: this.signal,
      });
      // A spoken "approve" answering this line names the gate it is answering,
      // exactly as one answering the card does.
      if (sent) pending.messageIds = [...(pending.messageIds ?? []), ...sent];
    } catch (err) {
      this.onError?.(
        `Forge remote approval notice failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async publishResolution(
    pending: RemoteApprovalEntry,
    event: ToolApprovalResolvedEvent,
  ): Promise<void> {
    if (!(await this.auth.canDeliver(this.channel.name, pending.chatId))) return;
    const correlationId = pending.actionId ?? event.id;
    if (this.channel.resolvePromptKeyboard) {
      // Grey the row out rather than remove it, so the chat keeps a visible
      // record of which gate was answered and how. The transport already tried
      // the empty-keyboard fallback for any message it could not disable, so
      // all that is left here is to say so out loud.
      try {
        await this.channel.resolvePromptKeyboard(
          pending.chatId,
          correlationId,
          pending.keyboardMessageIds ?? [],
          event.approved,
          { signal: this.signal },
          event.reason === 'timeout' ? 'timeout' : undefined,
          // The button a card keeps has to name the choice that was made: the
          // bridge already knows it (it routed the tap at `resolveAction` and
          // words the receipt below with the same field), so leaving it out
          // would make `Allow for this chat` and `Approve` look identical on
          // the one message still on screen afterwards.
          event.decision,
        );
      } catch (err) {
        this.onError?.(
          `Forge Telegram approval buttons could not be resolved: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      await this.channel
        .retractPrompt?.(pending.chatId, correlationId, this.signal)
        .catch(() => undefined);
    }
    // Telegram's disabled button is the edited receipt. A second message would
    // duplicate the timeout result without adding a new decision surface.
    if (event.reason === 'timeout' && this.channel.resolvePromptKeyboard) return;
    try {
      const sent = await this.channel.send(
        pending.chatId,
        event.approvalNotice
          ? event.approvalNotice
          : event.decision === 'allowChat'
            ? 'Forge approval allowed for this chat (' +
              (pending.event.allowForChat?.label ?? 'the offered rules') +
              ').'
            : event.decision === 'alwaysProject'
              ? 'Forge approval always allowed in this project (' +
                (pending.event.alwaysInProject?.label ?? 'the offered rules') +
                ').'
              : 'Forge approval ' +
                (event.approved ? 'approved' : 'denied') +
                ' (' +
                event.reason +
                ').',
        { signal: this.signal },
      );
      // An approval is a receipt for what the user just did; a denial changes
      // what the turn does next, so it stays in the chat.
      if (event.approved) this.cleanup?.armEphemeral(pending.chatId, sent ?? []);
    } catch (err) {
      this.onError?.(
        `Forge remote approval update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private report(operation: string, err: unknown): void {
    this.onError?.(
      `Forge remote ${operation}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
