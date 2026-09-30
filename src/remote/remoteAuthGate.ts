import { isRemoteCommand } from './RemotePromptAdmission';
import { previewPrompt, type RemotePendingPrompt } from './RemotePendingPrompt';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteApprovalBridge } from './RemoteApprovalBridge';
import type { RemoteQuestionBridge } from './RemoteQuestionBridge';
import type { RemoteOutboxDelivery } from './RemoteOutboxDelivery';
import type { TelegramContactService } from './TelegramContactService';
import type { RemoteAuditLog } from './RemoteAuditLog';
import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';

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
    return { kind: 'rejected', reason: 'sender is not paired', ephemeral: true };
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
    return {
      kind: 'rejected',
      reason: 'remote authentication is temporarily locked',
      ephemeral: true,
    };
  }
  if (gate.kind === 'blocked') {
    return { kind: 'rejected', reason: 'remote authentication is required', ephemeral: true };
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
