import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';
import type { RemoteCommandContext } from './RemoteCommandHandler';
import { approvalLinesForChat } from '../sidebar/chatApprovalRules';

/**
 * The owner-facing remote settings commands: `/clanker`, `/timeout`, and
 * `/ratelimit`. Returns a disposition when the command is one of these, or
 * `undefined` to let the next handler in the chain take it.
 */
export async function handleRemoteSettingsCommand(
  command: string,
  argument: string | undefined,
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteCommandContext,
): Promise<RemoteInboundDisposition | undefined> {
  if (command === '/clanker') {
    const desired = argument?.toLowerCase();
    if (desired !== 'on' && desired !== 'off') {
      return { kind: 'rejected', reason: 'usage: /clanker on|off' };
    }
    // Owner-authenticated command, never a tool: a model that could call this
    // would be able to switch off its own approval gate mid-turn. It acts on the
    // chat this phone is bound to and on no other: the mode is a chat's, so arming
    // it here cannot arm a tab the owner is watching in the sidebar.
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    context.host.setClankerMode(binding.conversationId, desired === 'on');
    await context.channel.send(
      event.chatId,
      desired === 'on'
        ? "Forge: clanker mode ON for this chat only. A call the owner could have allowed by key now runs with no approval; the deny list's dangerous commands and anything with no key still get a card, here or in the sidebar, and that card waits or times out like any other. The mode is saved with this chat and survives a window reload; /clanker off turns it off."
        : 'Forge: clanker mode OFF for this chat. It is gated again, and the approvals this chat earned are not revoked.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/approvals') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    if (argument === undefined || argument.trim() === '') {
      const conversation = context.host.getConversation(binding.conversationId);
      const lines = conversation
        ? [
            ...approvalLinesForChat(conversation.id, conversation),
            ...(context.getApprovalPolicyLines?.() ?? []),
          ]
        : [];
      await context.channel.send(
        event.chatId,
        lines.length ? lines.join('\n') : 'No approvals in this chat.',
        { signal: context.signal },
      );
      return { kind: 'handled' };
    }
    if (argument.trim().toLowerCase() !== 'reset') {
      return { kind: 'rejected', reason: 'usage: /approvals or /approvals reset' };
    }
    const saved = await context.host.resetApprovals(binding.conversationId);
    await context.channel.send(
      event.chatId,
      saved
        ? 'Forge: approvals reset for this chat. The next gated call asks again.'
        : 'Forge: could not save the approval reset for this chat.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/timeout') {
    if (!argument) {
      await context.channel.send(
        event.chatId,
        `Forge: remote inactivity timeout is ${
          context.inactivityTimeoutMinutes === 0
            ? 'off'
            : `${context.inactivityTimeoutMinutes} minutes`
        }.`,
        { signal: context.signal },
      );
      return { kind: 'handled' };
    }
    const minutes = argument.toLowerCase() === 'off' ? 0 : Number(argument);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1_440) {
      return { kind: 'rejected', reason: 'usage: /timeout <1-1440|off>' };
    }
    if (!context.setInactivityTimeout) {
      return { kind: 'rejected', reason: 'remote timeout configuration is unavailable' };
    }
    await context.setInactivityTimeout(minutes);
    await context.channel.send(
      event.chatId,
      `Forge: remote inactivity timeout ${minutes === 0 ? 'disabled' : `set to ${minutes} minutes`}.`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/ratelimit') {
    if (!argument) {
      await context.channel.send(
        event.chatId,
        `Forge: remote rate limit is ${context.rateLimitPerMinute} messages per minute.`,
        { signal: context.signal },
      );
      return { kind: 'handled' };
    }
    // `off` maps to the schema ceiling rather than removing the limiter. The
    // limiter is the only backstop the Telegram poll loop has against a single
    // poisoned update being redelivered forever; a true “off” would trade a
    // visible error for a silent hot loop.
    const perMinute = argument.toLowerCase() === 'off' ? 600 : Number(argument);
    if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 600) {
      return { kind: 'rejected', reason: 'usage: /ratelimit <1-600|off>' };
    }
    if (!context.setRateLimit) {
      return { kind: 'rejected', reason: 'remote rate limit configuration is unavailable' };
    }
    await context.setRateLimit(perMinute);
    await context.channel.send(
      event.chatId,
      `Forge: remote rate limit set to ${perMinute} messages per minute.`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  return undefined;
}
