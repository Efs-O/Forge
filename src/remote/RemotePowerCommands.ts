/**
 * `/sleep` and `/wake` for a paired chat.
 *
 * Split from `RemoteCommandHandler` because these two carry state that no other
 * command does: a `/sleep` must be confirmed before it lands. There is no
 * button affordance on `RemoteChannel` — approvals have their own bridge, and
 * widening the channel interface for one command would put a Telegram-shaped
 * feature in every transport's contract — so the confirmation is a second
 * message. Same guarantee, no new surface.
 *
 * The asymmetry between the two commands is the point. `/sleep` does what it
 * says. `/wake` cannot: once the machine is suspended nothing on it is running,
 * so no message can reach it. What `/wake` does instead is arm the RTC in
 * advance, or report the Wake-on-LAN details for a packet sent from a device
 * that is awake. Naming it `/wake` anyway is deliberate — that is the word the
 * user will type, and a command that explains the real path beats an unknown
 * command that teaches nothing.
 */

import type { PowerControl } from '../system/PowerControl';
import { WakeTimersDisabledError } from '../system/PowerControl';
import { formatWakeInfo, parseWakeTime } from '../system/wakeInfo';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';

/** How long a `/sleep` stays confirmable. Short: this is a destructive action. */
const CONFIRM_WINDOW_MS = 90_000;
/** Grace before suspending, so the reply reaches the phone before the NIC does. */
const SLEEP_GRACE_MS = 8_000;

interface PendingSleep {
  chatId: string;
  hibernate: boolean;
  wakeAt: Date | undefined;
  expiresAt: number;
}

export interface RemotePowerContext {
  channel: RemoteChannel;
  host: ForgeHostFacade;
  signal: AbortSignal;
  power: PowerControl;
}

/**
 * Pending confirmations, keyed by `channel:chatId`.
 *
 * Module-level rather than threaded through `RemoteCommandContext`: it is
 * per-process, self-expiring, and exists only between two consecutive messages
 * from one chat. A window reload drops it, which is the correct behaviour — a
 * `/sleep` nobody confirmed must not survive into a new session.
 */
const pending = new Map<string, PendingSleep>();

function keyOf(context: RemotePowerContext, chatId: string): string {
  return `${context.channel.name}:${chatId}`;
}

/** True while a turn, a queued request, or an approval is outstanding. */
function busyReason(host: ForgeHostFacade): string | undefined {
  const status = host.status();
  if (status.streamingConversationIds.length) return 'a turn is still running';
  if (status.requestChains.length) return 'a request is still in flight';
  if (status.pendingApproval) return 'a tool approval is waiting for you';
  return undefined;
}

async function reply(context: RemotePowerContext, chatId: string, text: string): Promise<void> {
  await context.channel.send(chatId, text, { signal: context.signal });
}

/**
 * Handle `/sleep` and `/wake`. Returns undefined when the command is neither,
 * so the caller falls through to the rest of the command map.
 */
export async function handleRemotePowerCommand(
  command: string | undefined,
  operands: readonly string[],
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemotePowerContext,
): Promise<RemoteInboundDisposition | undefined> {
  if (command === '/sleep') return handleSleep(operands, event, context);
  if (command === '/wake') return handleWake(operands, event, context);
  return undefined;
}

async function handleSleep(
  operands: readonly string[],
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemotePowerContext,
): Promise<RemoteInboundDisposition> {
  const key = keyOf(context, event.chatId);
  const flags = operands.map((operand) => operand.toLowerCase());
  const confirming = flags.includes('confirm');
  const forcing = flags.includes('force');
  const hibernate = flags.includes('hibernate');

  if (confirming) {
    const held = pending.get(key);
    pending.delete(key);
    if (!held || held.expiresAt < Date.now()) {
      return {
        kind: 'rejected',
        reason: 'nothing to confirm — send /sleep first (a confirmation expires after 90s)',
      };
    }
    return performSleep(held, event.chatId, context);
  }

  const busy = busyReason(context.host);
  if (busy && !forcing) {
    return {
      kind: 'rejected',
      reason: `${busy}. Wait for it, or send \`/sleep force\` to suspend anyway`,
    };
  }

  // The wake time is parsed BEFORE the confirmation is offered: a typo in it
  // must not be discovered after the machine is already going down.
  const timeOperand = flags.find((operand) => !['confirm', 'force', 'hibernate'].includes(operand));
  let wakeAt: Date | undefined;
  if (timeOperand) {
    wakeAt = parseWakeTime(timeOperand);
    if (!wakeAt) {
      return {
        kind: 'rejected',
        reason:
          `could not read "${timeOperand}" as a wake time — use a duration (8h, 90m), ` +
          'a clock time (07:00), or omit it to sleep with no wake armed',
      };
    }
  }

  pending.set(key, {
    chatId: event.chatId,
    hibernate,
    wakeAt,
    expiresAt: Date.now() + CONFIRM_WINDOW_MS,
  });

  const info = await context.power.describeWake().catch(() => undefined);
  const armed = info?.adapters.find((adapter) => adapter.wakeArmed);
  const lines = [
    `Forge: about to ${hibernate ? 'hibernate' : 'sleep'} this machine.`,
    '',
    wakeAt
      ? `It will wake itself at ${wakeAt.toLocaleString()}.`
      : 'No wake timer will be armed, so it stays asleep until something wakes it.',
    '',
    armed
      ? `Wake-on-LAN is available: send a magic packet to ${armed.macAddress}` +
        (armed.broadcast ? ` (broadcast ${armed.broadcast}, UDP 9)` : '') +
        ' from a device on the same network.'
      : 'No adapter is wake-armed, so Wake-on-LAN will NOT work. Send /wake for details.',
    '',
    busy ? `Note: ${busy} — /sleep force will suspend anyway.` : '',
    'Send `/sleep confirm` within 90 seconds to go ahead.',
  ].filter((line) => line !== '');
  await reply(context, event.chatId, lines.join('\n'));
  return { kind: 'handled' };
}

async function performSleep(
  held: PendingSleep,
  chatId: string,
  context: RemotePowerContext,
): Promise<RemoteInboundDisposition> {
  if (held.wakeAt) {
    try {
      // Armed before the suspend, not after: after, there is no "after".
      await context.power.armWakeTimer(held.wakeAt);
    } catch (err) {
      const detail = err instanceof WakeTimersDisabledError ? err.message : (err as Error).message;
      await reply(
        context,
        chatId,
        `Forge: the wake timer could not be armed, so nothing was suspended.\n\n${detail}`,
      );
      return { kind: 'handled' };
    }
  }

  await reply(
    context,
    chatId,
    `Forge: ${held.hibernate ? 'hibernating' : 'sleeping'} now.\n\n` +
      (held.wakeAt
        ? `It will wake itself at ${held.wakeAt.toLocaleString()} and come back online.`
        : 'Wake it with a magic packet — /wake showed the address.') +
      '\n\nThis chat goes quiet until then.',
  );

  // Delayed so the message above actually leaves the machine. Telegram's send
  // resolves when the API accepts it, which is not the same as the phone having
  // it, and suspending into an in-flight TLS write loses the reply outright.
  setTimeout(() => {
    void context.power.suspend({ hibernate: held.hibernate }).catch(() => undefined);
  }, SLEEP_GRACE_MS).unref?.();
  return { kind: 'handled' };
}

async function handleWake(
  operands: readonly string[],
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemotePowerContext,
): Promise<RemoteInboundDisposition> {
  const argument = operands[0]?.toLowerCase();

  if (argument === 'off' || argument === 'clear') {
    const removed = await context.power.clearWakeTimer();
    await reply(
      context,
      event.chatId,
      removed ? 'Forge: wake timer cleared.' : 'Forge: there was no wake timer armed.',
    );
    return { kind: 'handled' };
  }

  if (argument) {
    const target = parseWakeTime(argument);
    if (!target) {
      return {
        kind: 'rejected',
        reason:
          `could not read "${argument}" as a time — use a duration (8h, 90m), a clock ` +
          'time (07:00), or /wake off to clear',
      };
    }
    try {
      await context.power.armWakeTimer(target);
    } catch (err) {
      const detail = err instanceof WakeTimersDisabledError ? err.message : (err as Error).message;
      await reply(context, event.chatId, `Forge: could not arm the wake timer.\n\n${detail}`);
      return { kind: 'handled' };
    }
    await reply(
      context,
      event.chatId,
      `Forge: this machine will wake at ${target.toLocaleString()}.\n\n` +
        'It resumes on its own — Forge and this chat come back with it.',
    );
    return { kind: 'handled' };
  }

  const info = await context.power.describeWake();
  await reply(context, event.chatId, formatWakeInfo(info));
  return { kind: 'handled' };
}

/** Test seam: drops any confirmation this process is holding. */
export function resetPendingSleeps(): void {
  pending.clear();
}
