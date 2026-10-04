import type { RemoteCommandContext } from './RemoteCommandHandler';
import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { getMeshOrchestrator } from '../agentMesh/meshContext';
import { MAX_TELL_MESSAGE_CHARS } from '../tools/tellLiveSessionTool';

/**
 * Phase 5: `/claude <msg>`, `/codex <msg>`, `/copilot <msg>` — a one-way note
 * from Telegram into a live session's FIFO, through the same door
 * `tell_live_session` uses.
 *
 * It is deliberately a **tell**, never an ask: a notification has no expected
 * answer, no correlation id, and no reply contract. The wording of every
 * success here says "accepted", never "started" or "delivered", because
 * `tell()` returns as soon as the message is durably queued. The outcome's
 * `observing` flag describes session ownership, not proof that anything has
 * run yet, so it is not reported either — a remote user who is told "started"
 * will wait for an answer that this command never promised.
 *
 * Gating is `getMeshOrchestrator() !== undefined`, the single guard that
 * subsumes `agent_bus.enabled`: the orchestrator exists only when the bus is
 * up. The unattended-CLI gate is NOT applied here — it exists for unattended
 * turns, and a command a person typed into Telegram is attended.
 */

/**
 * Command token → mesh alias. One entry per alias, matching the aliases.
 * `as const` so the keys stay literal: the type guard narrows `command` to
 * exactly these tokens, and `alias` is then known to be one of the three.
 */
export const SESSION_TELL_ALIASES = {
  '/claude': 'claude',
  '/codex': 'codex',
  '/copilot': 'copilot',
} as const;

function isSessionTellCommand(command: string): command is keyof typeof SESSION_TELL_ALIASES {
  return Object.hasOwn(SESSION_TELL_ALIASES, command);
}

export async function handleRemoteSessionTellCommand(
  command: string,
  operands: readonly string[],
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteCommandContext,
): Promise<RemoteInboundDisposition | undefined> {
  if (!isSessionTellCommand(command)) return undefined;
  const alias = SESSION_TELL_ALIASES[command];

  // The whole remainder is the message: a note about a build reads
  // "build 2 failed on linux", and splitting on the first space would send
  // "build" and silently drop the rest.
  const message = operands.join(' ').trim();
  if (message === '') {
    return { kind: 'rejected', reason: `usage: ${command} <message>` };
  }
  // Same ceiling as `tell_live_session`, read from that module rather than
  // restated, so the two doors cannot drift apart on a limit change.
  if (message.length > MAX_TELL_MESSAGE_CHARS) {
    return {
      kind: 'rejected',
      reason: `${command} message is ${message.length} chars; the limit is ${MAX_TELL_MESSAGE_CHARS}.`,
    };
  }

  const orchestrator = getMeshOrchestrator();
  if (!orchestrator) {
    return { kind: 'rejected', reason: 'the agent mesh is not up in this window' };
  }

  // A non-observing session otherwise gets an appended verdict-file request.
  // This command promises a one-way note, with no response expected.
  const outcome = await orchestrator.tell(alias, message, { expectsReply: false });
  if ('error' in outcome) {
    // Verbatim: the mesh's own reasons ("no live session for …", "queue full
    // for … (N); message rejected", "unknown recipient …") name what the user
    // can do about it. Paraphrasing them would hide the live-alias list the
    // unknown-recipient error carries.
    return { kind: 'rejected', reason: outcome.error };
  }

  // Accepted, durably queued, and already recorded as an exchange. From here a
  // failed acknowledgement must NOT throw: `handleRemoteCommand` turns a throw
  // into a discarded receipt and a `retry`, the Telegram poll loop redelivers
  // the update, and the same note is enqueued a second time. The mesh has the
  // message; the only loss is the receipt the user never sees.
  const acknowledgement =
    `Forge: ${alias} accepted the note (exchange ${outcome.exchangeId}). ` +
    'Queued to that session — it is not a question, so nothing is waiting here.';
  try {
    await context.channel.send(event.chatId, acknowledgement, { signal: context.signal });
  } catch (err) {
    const failure = `Forge ${command} acknowledgement could not be delivered: ${
      err instanceof Error ? err.message : String(err)
    }`;
    try {
      context.onError?.(failure);
    } catch (reportError) {
      // A logger failure must not discard the completed control receipt and
      // enqueue the same durable note again on Telegram redelivery.
      console.error(failure, reportError); // eslint-disable-line no-console -- emergency fallback when onError throws
    }
  }
  return { kind: 'handled' };
}
