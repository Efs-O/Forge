import { isRemoteCommand } from './RemotePromptAdmission';
import { previewPrompt, type RemotePendingPrompt } from './RemotePendingPrompt';
import { ephemeralRejection } from './RemoteEphemeralMessages';
import { extractCode } from './RemoteSessionAuth';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteApprovalBridge } from './RemoteApprovalBridge';
import type { RemoteQuestionBridge } from './RemoteQuestionBridge';
import type { RemoteOutboxDelivery } from './RemoteOutboxDelivery';
import type { TelegramContactService } from './TelegramContactService';
import type { RemoteAuditLog } from './RemoteAuditLog';
import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

/** What an already-unlocked chat says when a code arrives that nothing asked for. */
const ALREADY_UNLOCKED_REPLY =
  'Forge: this chat is already unlocked, so that code was not sent to the model. ' +
  'To send the number to the model, add a word to it.';

export type RemoteAuthGateOutcome =
  | RemoteInboundDisposition
  | { continue: true; nonce: string | undefined };

export interface RemoteAuthGateDeps {
  auth: RemoteAuth;
  contactService?: TelegramContactService;
  audit?: RemoteAuditLog;
  sendTransientMessage: (chatId: string, text: string) => Promise<void>;
  pending: RemotePendingPrompt;
  outbox: RemoteOutboxDelivery;
  store: RemoteRequestStore;
  kickDrain: (conversationId: string) => void;
  approvals: RemoteApprovalBridge;
  questions: RemoteQuestionBridge;
  inactivityTimeoutMinutes: () => number | undefined;
  rehandle: (event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>;
  scheduleCommandCleanup: (event: Extract<RemoteInboundEvent, { kind: 'text' }>) => void;
}

export async function applyRemoteAuthGate(
  event: RemoteInboundEvent,
  deps: RemoteAuthGateDeps,
): Promise<RemoteAuthGateOutcome> {
  if (!(await deps.auth.isOwner(event))) {
    const contactResult = await deps.contactService?.handleNonOwner(event);
    if (contactResult) return contactResult;
    if ((await deps.auth.tryPair(event)) === 'paired') {
      await deps.audit?.record(event, 'paired').catch(() => undefined);
      await deps.sendTransientMessage(event.chatId, 'Forge remote pairing complete.');
      return { kind: 'handled' };
    }
    return ephemeralRejection('sender is not paired');
  }
  const gate = await deps.auth.gate(event);
  if (gate.kind === 'challenge') {
    await deps.audit?.record(event, 'authentication_challenge').catch(() => undefined);
    const held = event.kind === 'text' && !isRemoteCommand(event.text);
    if (held) deps.pending.hold(event);
    const idleMinutes = deps.inactivityTimeoutMinutes() ?? 30;
    const cause =
      gate.reason === 'expired'
        ? `session expired after ${idleMinutes} min idle`
        : 'authentication required';
    await deps.sendTransientMessage(
      event.chatId,
      held
        ? `Forge: ${cause}. Your prompt is held and will run once you verify — send your 6-digit code.`
        : `Forge: ${cause}. Send your 6-digit code, then send the command again — commands are not held.`,
    );
    return { kind: 'handled' };
  }
  if (gate.kind === 'failed') {
    await deps.audit?.record(event, 'authentication_failed').catch(() => undefined);
    await deps.sendTransientMessage(event.chatId, 'Forge: authentication failed.');
    return { kind: 'handled' };
  }
  if (gate.kind === 'locked_out') {
    await deps.audit?.record(event, 'authentication_locked_out').catch(() => undefined);
    deps.pending.clear(event.channel, event.chatId);
    return ephemeralRejection('remote authentication is temporarily locked');
  }
  if (gate.kind === 'blocked') {
    return ephemeralRejection('remote authentication is required');
  }
  if (gate.newlyAuthenticated) {
    await deps.audit?.record(event, 'authenticated').catch(() => undefined);
    deps.outbox.kick();
    const binding = deps.store.binding(event.channel, event.chatId);
    if (binding) deps.kickDrain(binding.conversationId);
    for (const bridge of [deps.approvals, deps.questions]) bridge.republish(event.chatId);
    await deps.sendTransientMessage(event.chatId, 'Forge: authenticated.');
    const heldPrompt = deps.pending.take(event.channel, event.chatId);
    if (!heldPrompt) return { kind: 'handled' };
    await deps.audit?.record(heldPrompt, 'held_prompt_replayed').catch(() => undefined);
    await deps.sendTransientMessage(
      event.chatId,
      `Forge: running your held prompt — ${previewPrompt(heldPrompt.text)}`,
    );
    return deps.rehandle(heldPrompt);
  }
  // A code that reaches a chat which is already unlocked answers nothing, and
  // it is not work for the agent either. On 2026-10-27 the owner sent 095190 to
  // an unlocked chat: the log shows `update 931343637 text(6 chars) -> accepted`
  // and a turn started with the number as its prompt, so the model answered a
  // TOTP code. It is answered here instead and never admitted.
  //
  // Only the code-shaped message is held out — `Order 123456` is a sentence and
  // still reaches the model. A number a waiting question asked for is still an
  // answer, so `awaitingAnswer` is checked first and those numbers go on to the
  // question, approval and reply-to paths below.
  if (
    event.kind === 'text' &&
    !gate.newlyAuthenticated &&
    extractCode(event.text) !== undefined &&
    !awaitingAnswer(deps, event)
  ) {
    await deps.audit?.record(event, 'redundant_unlock_code').catch(() => undefined);
    // Deliberately no `deps.auth.touch`: an ignored message must not buy the
    // session another stretch of inactivity time.
    await deps.sendTransientMessage(event.chatId, ALREADY_UNLOCKED_REPLY);
    return { kind: 'handled' };
  }
  if (event.kind === 'text' && event.text === '/lock') {
    deps.auth.lock(event);
    deps.pending.clear(event.channel, event.chatId);
    await deps.audit?.record(event, 'session_locked').catch(() => undefined);
    await deps.sendTransientMessage(event.chatId, 'Forge: remote session locked.');
    deps.scheduleCommandCleanup(event);
    return { kind: 'handled' };
  }
  return { continue: true, nonce: gate.nonce };
}

/**
 * Whether a six-digit number in this chat is the answer to something rather
 * than a stray code. Every branch is an answer path that exists below this
 * gate, so the check stays conservative: when a number could plausibly be an
 * answer, it is left to the path that already handles it.
 */
function awaitingAnswer(deps: RemoteAuthGateDeps, event: TextEvent): boolean {
  // An ask_user or remote-ask question waiting in this chat claims plain text.
  if (deps.questions.hasPending(event.chatId)) return true;
  // An approval still open in this chat: buttons, a spoken word or typed text
  // can all resolve it, so the number may be that answer. Recently-closed gates
  // come back from `pendingGates` too and are not answers still owed.
  if (deps.approvals.pendingGates(event.chatId).some((gate) => gate.resolvedAt === undefined))
    return true;
  // A message sent as a reply is addressed to the message it quotes — a session
  // question, an agent-ask question or an approval — and those paths own it
  // below. Swallowing it here would eat an answer the owner meant to send.
  return event.replyToMessageId !== undefined;
}
