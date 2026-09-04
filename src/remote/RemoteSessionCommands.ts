import type { RemoteCommandContext } from './RemoteCommandHandler';
import { HELP_TEXT, decorateHelpLine } from './remoteHelpText';
import { boldLeadingNumber, boldLineLabel, sendRichText } from './telegramHtml';
import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

/**
 * How long `/reload` waits before tearing the window down.
 *
 * Long enough for the durable control receipt and the transport's update
 * cursor to be written by the code that runs after this command returns —
 * both are small local writes. Short enough that the user, who has just been
 * told the window is reloading, cannot tell it was deferred.
 */
const RELOAD_SETTLE_MS = 1_000;

/** Line labels `/status` owns; bolding them makes the report scannable. */
const STATUS_LABELS = new Set(['Workspace', 'Chat', 'Model', 'Forge', 'Context', 'Approvals']);

/** Line labels `/context` owns. */
const CONTEXT_LABELS = new Set(['Forge context', 'Remaining']);

/** Queue/session commands split from model, workspace, and lifecycle controls. */
export async function handleRemoteSessionCommand(
  command: string,
  argument: string | undefined,
  event: TextEvent,
  context: RemoteCommandContext,
): Promise<RemoteInboundDisposition | undefined> {
  if (command === '/help' || command === '/commands') {
    // Per-command descriptions already ship as Telegram's native command menu,
    // so repeating them here only doubled the length of the message. What is
    // left is a map, and a map is only useful if it is scannable: one group per
    // paragraph, one note per paragraph, nothing wrapping into its neighbour.
    await sendRichText(context.channel, event.chatId, HELP_TEXT, decorateHelpLine, {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  if (command === '/status') {
    const status = context.host.status();
    const binding = context.store.binding(event.channel, event.chatId);
    const queued = binding ? ownQueue(event, context, binding.conversationId).length : 0;
    const requests = context.store.requestHealth();
    const outbox = context.store.outboxHealth();
    const conversation = status.conversations.find((item) => item.id === binding?.conversationId);
    await sendRichText(
      context.channel,
      event.chatId,
      // The workspace leads: a chat reached through /new could be sitting in
      // any project on disk, and nothing else in the session says which.
      `Workspace: ${context.currentWorkspaceName ?? 'unknown'}${
        context.currentWorkspaceAlias ? ` (${context.currentWorkspaceAlias})` : ''
      }\n` +
        `Chat: ${conversation ? `${conversation.title} · ${conversation.id}` : 'none bound'}\n` +
        `Model: ${conversation?.activeModel ?? 'default'}\n` +
        `Forge: ${status.requestChains.length} active request(s), ${queued} queued here, ${status.streamingConversationIds.length} streaming, ${requests.unknown} crash-unknown, ${outbox.pending} notifications pending, ${outbox.abandoned} abandoned.\n` +
        `Context: ${describeBudget(binding && context.host.contextBudget(binding.conversationId))}\n` +
        `Approvals: ${context.host.clankerMode() ? 'CLANKER — non-dangerous tools auto-approved' : 'gated'}`,
      (line) => boldLineLabel(line, STATUS_LABELS),
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/context') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    await sendRichText(
      context.channel,
      event.chatId,
      describeDetailedBudget(context.host.contextBudget(binding.conversationId)),
      (line) => boldLineLabel(line, CONTEXT_LABELS),
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/stop') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    await context.host.cancel(binding.conversationId);
    await context.channel.send(
      event.chatId,
      'Forge: current request stopped; queued requests remain queued.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/notify') {
    if (!context.notifyMute) return { kind: 'rejected', reason: 'notifications are unavailable' };
    const desired = argument?.toLowerCase();
    if (desired !== 'on' && desired !== 'off' && desired !== undefined && desired !== 'status') {
      return { kind: 'rejected', reason: 'usage: /notify on|off|status' };
    }
    if (desired === 'on' || desired === 'off')
      context.notifyMute.set(event.chatId, desired === 'on');
    const on = context.notifyMute.get(event.chatId);
    await context.channel.send(
      event.chatId,
      on
        ? 'Forge: agent notifications ON for this chat.'
        : 'Forge: agent notifications OFF for this chat — the agent is told its message did not reach you. It does not survive a window reload.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/mirror') {
    if (!context.mirrorToggle) return { kind: 'rejected', reason: 'turn mirroring is unavailable' };
    const desired = argument?.toLowerCase();
    if (desired !== 'on' && desired !== 'off' && desired !== undefined && desired !== 'status') {
      return { kind: 'rejected', reason: 'usage: /mirror on|off|status' };
    }
    if (desired === 'on' || desired === 'off')
      context.mirrorToggle.set(event.chatId, desired === 'on');
    const on = context.mirrorToggle.get(event.chatId);
    await context.channel.send(
      event.chatId,
      on
        ? 'Forge: mirroring ON — answers typed in the Forge window are echoed here.'
        : 'Forge: mirroring OFF — you will only see turns you asked for from this chat. It does not survive a window reload.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/voice') {
    if (!context.voiceToggle) {
      return { kind: 'rejected', reason: 'spoken replies are not available in this window' };
    }
    const desired = argument?.toLowerCase();
    if (desired !== 'on' && desired !== 'off' && desired !== undefined && desired !== 'status') {
      return { kind: 'rejected', reason: 'usage: /voice on|off|status' };
    }
    if (desired === 'on' || desired === 'off') {
      try {
        await context.voiceToggle.set(desired === 'on');
      } catch (err) {
        return {
          kind: 'rejected',
          reason: `could not update voice setting: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }
    const on = context.voiceToggle.get();
    await context.channel.send(
      event.chatId,
      on
        ? 'Forge: spoken replies ON — replies are also sent as a voice message. Saved to config.yaml.'
        : 'Forge: spoken replies OFF — replies are text only. Saved to config.yaml.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/reload') {
    if (!context.reloadWindow) {
      return { kind: 'rejected', reason: 'remote reload is unavailable' };
    }
    // The one command that ends the session it was typed into. /help says so,
    // but help is read before the fact and this is read at the moment it
    // matters: without it the chat simply goes quiet, and a quiet chat reads
    // as a hung reload rather than as a locked session waiting for a code.
    const reauth = (await context.totpEnrolled?.()) === true;
    await context.channel.send(
      event.chatId,
      reauth
        ? 'Forge: reloading the window… this session ends with it — send your 6-digit ' +
            'code when it is back. A held prompt and the queue are dropped too.'
        : 'Forge: reloading the window… a held prompt and the queue are dropped with it.',
      { signal: context.signal },
    );
    // Detached, not awaited. The reload tears down the extension host, so
    // anything after it never runs: awaiting it here killed the process before
    // handleRemoteCommand could mark the control receipt completed and before
    // the transport could commit its update cursor. The command was therefore
    // redelivered on the next start, still un-receipted, and ran again.
    // Returning first lets both land, after which a redelivery is recognised
    // as already handled and dropped.
    setTimeout(() => {
      void context.reloadWindow?.();
    }, RELOAD_SETTLE_MS).unref?.();
    return { kind: 'handled' };
  }
  if (command === '/queue') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    const queued = ownQueue(event, context, binding.conversationId);
    await sendRichText(
      context.channel,
      event.chatId,
      queued.length === 0
        ? 'Forge: no queued prompts for this chat.'
        : queued
            .map(
              (item, index) =>
                `${index + 1}. ${item.priority === 'steer' ? '[steer] ' : ''}${truncate(item.text, 160)}`,
            )
            .join('\n\n') + '\n\nUse /drop <number|all> to cancel queued work.',
      (line) => (line.startsWith('Use /') ? `<i>${line}</i>` : boldLeadingNumber(line)),
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/drop') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    if (!argument) return { kind: 'rejected', reason: 'usage: /drop <number|all>' };
    const queued = ownQueue(event, context, binding.conversationId);
    if (queued.length === 0) return { kind: 'rejected', reason: 'no queued prompts to cancel' };
    let selected: ReadonlySet<string>;
    if (argument.toLowerCase() === 'all') {
      selected = new Set(queued.map((item) => item.id));
    } else {
      if (!/^\d+$/.test(argument)) {
        return { kind: 'rejected', reason: 'usage: /drop <number|all>' };
      }
      const item = queued[Number(argument) - 1];
      if (!item) return { kind: 'rejected', reason: 'queue number is out of range' };
      selected = new Set([item.id]);
    }
    const cancelled = await context.store.cancelQueued(binding.conversationId, selected);
    await context.channel.send(
      event.chatId,
      `Forge: cancelled ${cancelled} queued prompt${cancelled === 1 ? '' : 's'}.`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  return undefined;
}

/** `max` is the per-slot window; a model with no resolvable num_ctx reports none. */
export function describeBudget(budget: { used: number; max: number } | undefined): string {
  if (!budget || budget.max <= 0) return 'unavailable (no num_ctx for this model)';
  const percent = Math.round((budget.used / budget.max) * 100);
  return `${budget.used}/${budget.max} tokens (${percent}%)`;
}

function describeDetailedBudget(budget: { used: number; max: number } | undefined): string {
  if (!budget || budget.max <= 0) return 'Forge context: unavailable (no num_ctx for this model).';
  const remaining = Math.max(0, budget.max - budget.used);
  const percent = Math.round((budget.used / budget.max) * 100);
  return (
    `Forge context: ${budget.used}/${budget.max} tokens (${percent}%).\n` +
    `Remaining: ${remaining} tokens. Auto-compaction uses the configured threshold and also runs after a recoverable context-exhaustion failure.`
  );
}

function ownQueue(event: TextEvent, context: RemoteCommandContext, conversationId: string) {
  return context.store
    .queued(conversationId)
    .filter((item) => item.channel === event.channel && item.chatId === event.chatId);
}

function truncate(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}
