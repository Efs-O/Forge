import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';
import type { RemoteCommandContext } from './RemoteCommandHandler';

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
    // would be able to switch off its own approval gate mid-turn.
    context.host.setClankerMode(desired === 'on');
    await context.channel.send(
      event.chatId,
      desired === 'on'
        ? 'Forge: clanker mode ON — non-dangerous tools now run with no approval, here or in the sidebar, for every tab in this window. It covers this workspace, and stays armed across a window reload until it is turned off.'
        : 'Forge: clanker mode OFF — tool approvals are gated again in this workspace, and stay gated across a reload.',
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
