import type { RemoteCommandContext } from './RemoteCommandHandler';
import { HELP_TEXT, renderRemoteHelpMenu } from './remoteHelpText';
import { escapeTelegramHtml } from './telegramHtml';
import { handleRemoteStatusReportCommand, remoteQueueForChat } from './remoteStatusReport';
import { telegramQueueButton } from './TelegramQueueButtons';
import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { formatElapsed } from './remoteProgressRender';
import { MAX_VIEW_COUNT, parseViewCount, sendTranscriptView } from './RemoteTranscriptView';
import { isAskAgentRunning } from '../agentLinks/askAgentService';
import { formatRemoteRelativeDate } from './RemoteDateTime';
import { telegramCloseButton } from './TelegramHelpButtons';

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

/** Queue/session commands split from model, workspace, and lifecycle controls. */
export async function handleRemoteSessionCommand(
  command: string,
  argument: string | undefined,
  event: TextEvent,
  context: RemoteCommandContext,
): Promise<RemoteInboundDisposition | undefined> {
  const reportCommand = await handleRemoteStatusReportCommand(command, event, context);
  if (reportCommand) return reportCommand;
  if (command === '/help' || command === '/commands' || command === '/start') {
    if (context.channel.parseMode && context.channel.sendHelp) {
      const menu = renderRemoteHelpMenu();
      await context.channel.sendHelp(event.chatId, menu.html, {
        signal: context.signal,
        parseMode: 'HTML',
        buttons: menu.buttons,
      });
    } else {
      await context.channel.send(event.chatId, HELP_TEXT, { signal: context.signal });
    }
    return { kind: 'handled' };
  }
  if (command === '/view') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    const requested = parseViewCount(argument);
    if (requested.kind === 'invalid') {
      return { kind: 'rejected', reason: `usage: /view [1-${String(MAX_VIEW_COUNT)}]` };
    }
    // Read from the host, not from the session log: that file re-appends the
    // whole conversation on every reload for sessions written before 0.13.20,
    // so a recap built from it shows the same answer several times over.
    await sendTranscriptView(
      context.channel,
      event.chatId,
      context.host.recentExchanges(binding.conversationId, requested.count),
      { clamped: requested.clamped, signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/stop') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    await context.host.cancel(binding.conversationId);
    await context.channel.send(
      event.chatId,
      'Forge: current request and linked-agent ask stopped; queued requests remain queued.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/agents') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    const status = isAskAgentRunning(binding.conversationId) ? 'running' : 'idle';
    const lines = (['claude', 'codex', 'copilot'] as const).map((kind) => {
      const title = kind[0]!.toUpperCase() + kind.slice(1);
      const link = context.host.getAgentLink(binding.conversationId, kind);
      if (!link) return { html: `<b>${title}</b> · not linked`, plain: `${title} · not linked` };
      const meta = `${link.title} · ${formatRemoteRelativeDate(link.lastUsedAt)}`;
      return {
        html: `<b>${title} · ${status}</b>\n${escapeTelegramHtml(meta)}`,
        plain: `${title} · ${status}\n${meta}`,
      };
    });
    const html = `<b>Linked agents</b> <i>· this chat</i>\n\n${lines.map((line) => line.html).join('\n\n')}`;
    const plain = `Linked agents · this chat\n\n${lines.map((line) => line.plain).join('\n\n')}`;
    const buttons = [
      [
        { text: 'Ask Claude', callbackData: 'a:claude' },
        { text: 'Ask Codex', callbackData: 'a:codex' },
        { text: 'Ask Copilot', callbackData: 'a:copilot' },
      ],
      [telegramCloseButton()],
    ];
    if (context.channel.parseMode && context.channel.sendInlineKeyboard) {
      if (context.telegramEditMessageId && context.channel.editInlineKeyboardMessage) {
        await context.channel.editInlineKeyboardMessage(
          event.chatId,
          context.telegramEditMessageId,
          html,
          buttons,
          {
            signal: context.signal,
            parseMode: 'HTML',
          },
        );
      } else {
        await context.channel.sendInlineKeyboard(event.chatId, html, buttons, {
          signal: context.signal,
          parseMode: 'HTML',
        });
      }
    } else {
      await context.channel.send(event.chatId, plain, { signal: context.signal });
    }
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
    const queued = remoteQueueForChat(event, context, binding.conversationId);
    const report = renderQueueReport(queued);
    if (context.telegramEditMessageId && context.channel.editInlineKeyboardMessage) {
      await context.channel.editInlineKeyboardMessage(
        event.chatId,
        context.telegramEditMessageId,
        report.html,
        report.buttons,
        { signal: context.signal, parseMode: 'HTML' },
      );
    } else if (
      context.channel.parseMode &&
      context.channel.sendInlineKeyboard &&
      report.buttons.length > 0
    ) {
      await context.channel.sendInlineKeyboard(event.chatId, report.html, report.buttons, {
        signal: context.signal,
        parseMode: 'HTML',
      });
    } else if (context.channel.parseMode && context.channel.sendHtml) {
      await context.channel.sendHtml(event.chatId, report.html, { signal: context.signal });
    } else {
      await context.channel.send(event.chatId, report.plain, { signal: context.signal });
    }
    return { kind: 'handled' };
  }
  if (command === '/drop') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    if (!argument) return { kind: 'rejected', reason: 'usage: /drop <number|all>' };
    const queued = remoteQueueForChat(event, context, binding.conversationId);
    if (queued.length === 0) {
      if (context.telegramEditMessageId) {
        await context.channel.send(event.chatId, 'Already gone.', { signal: context.signal });
        await editQueueBoard(event, context, binding.conversationId);
        return { kind: 'handled' };
      }
      return { kind: 'rejected', reason: 'no queued prompts to cancel' };
    }
    let selected: ReadonlySet<string>;
    if (argument.toLowerCase() === 'all') {
      selected = new Set(queued.map((item) => item.id));
    } else {
      const byId = queued.find((item) => item.id === argument);
      if (!byId && context.telegramEditMessageId) {
        await context.channel.send(event.chatId, 'Already gone.', { signal: context.signal });
        await editQueueBoard(event, context, binding.conversationId);
        return { kind: 'handled' };
      }
      if (!byId && !/^\d+$/.test(argument)) {
        return { kind: 'rejected', reason: 'usage: /drop <number|all>' };
      }
      const item = byId ?? queued[Number(argument) - 1];
      if (!item) return { kind: 'rejected', reason: 'queue number is out of range' };
      selected = new Set([item.id]);
    }
    const cancelled = await context.store.cancelQueued(binding.conversationId, selected);
    for (const requestId of selected) {
      if (context.store.getRequest(requestId)?.state === 'cancelled') {
        await context.channel.retireQueuedReceipt?.(requestId);
      }
    }
    await context.channel.send(
      event.chatId,
      `Forge: cancelled ${cancelled} queued prompt${cancelled === 1 ? '' : 's'}.`,
      { signal: context.signal },
    );
    if (context.telegramEditMessageId) {
      await editQueueBoard(event, context, binding.conversationId);
    }
    return { kind: 'handled' };
  }
  return undefined;
}

/**
 * The Work and Active time lines, shared by `/status` and the agent bus status.
 * Tool calls are counted as dispatched, so a refused or failed one still shows:
 * it cost a round either way. Active time is the VS Code status bar's timer, so
 * the phone, the bus and the bar agree.
 */
export function describeWork(
  conversation:
    | {
        requestCount?: number | undefined;
        toolCallCount?: number | undefined;
        compactCount?: number | undefined;
        activeMs?: number | undefined;
      }
    | undefined,
): string {
  const work = `Work: ${String(conversation?.requestCount ?? 0)} model request(s), ${String(
    conversation?.toolCallCount ?? 0,
  )} tool call(s), ${String(conversation?.compactCount ?? 0)} compaction(s) in this chat`;
  if (conversation?.activeMs === undefined) return work;
  return `${work}\nActive time: ${formatElapsed(conversation.activeMs)} (model work and tools, approval waits excluded)`;
}

/** `max` is the per-slot window; a model with no resolvable num_ctx reports none. */
export function describeBudget(budget: { used: number; max: number } | undefined): string {
  if (!budget || budget.max <= 0) return 'unavailable (no num_ctx for this model)';
  const percent = Math.round((budget.used / budget.max) * 100);
  return `${budget.used}/${budget.max} tokens (${percent}%)`;
}

function renderQueueReport(queued: ReturnType<RemoteCommandContext['store']['queued']>): {
  html: string;
  plain: string;
  buttons: Array<Array<{ text: string; callbackData: string }>>;
} {
  const rows = queued.map((item, index) => {
    const text = truncate(item.text.replace(/[\r\n]+/gu, ' '), 120);
    const photoCount =
      item.attachments?.filter((attachment) => attachment.mediaType.startsWith('image/')).length ??
      0;
    const fileCount = (item.attachments?.length ?? 0) - photoCount;
    const attachment =
      photoCount > 0 ? `${photoCount} photos` : fileCount > 0 ? `${fileCount} files` : undefined;
    const tags = [
      ...(item.priority === 'steer' ? ['<b>steer</b>'] : []),
      ...(attachment ? [`<b>${escapeTelegramHtml(attachment)}</b>`] : []),
    ];
    return {
      html: `<b>${index + 1}.</b> ${escapeTelegramHtml(text)}${tags.length ? ` · ${tags.join(' · ')}` : ''}`,
      plain: `${index + 1}. ${text}${item.priority === 'steer' ? ' · steer' : ''}${attachment ? ` · ${attachment}` : ''}`,
    };
  });
  const headerHtml = `<b>Queue</b> <i>· ${queued.length} waiting</i>`;
  const headerPlain = `Queue · ${queued.length} waiting`;
  const bodyHtml =
    queued.length === 0
      ? 'Nothing queued.'
      : `${rows.map((row) => row.html).join('\n')}\n\n<i>Text reaches the turn at its next step; photos wait for it to end.</i>`;
  const bodyPlain =
    queued.length === 0
      ? 'Nothing queued.'
      : `${rows.map((row) => row.plain).join('\n')}\n\nText reaches the turn at its next step; photos wait for it to end.`;
  const buttons: Array<Array<{ text: string; callbackData: string }>> = [];
  if (queued.length > 0 && queued.length <= 10) {
    for (let offset = 0; offset < queued.length; offset += 3) {
      buttons.push(
        queued
          .slice(offset, offset + 3)
          .map((item, index) => telegramQueueButton(`Drop ${offset + index + 1}`, item.id)),
      );
    }
    buttons.push([telegramQueueButton('Drop all', 'all')]);
  }
  buttons.push([telegramCloseButton()]);
  return {
    html: `${headerHtml}\n${bodyHtml}`,
    plain: `${headerPlain}\n${bodyPlain}`,
    buttons,
  };
}

async function editQueueBoard(
  event: TextEvent,
  context: RemoteCommandContext,
  conversationId: string,
): Promise<void> {
  if (!context.telegramEditMessageId || !context.channel.editInlineKeyboardMessage) return;
  const report = renderQueueReport(remoteQueueForChat(event, context, conversationId));
  await context.channel.editInlineKeyboardMessage(
    event.chatId,
    context.telegramEditMessageId,
    report.html,
    report.buttons,
    { signal: context.signal, parseMode: 'HTML' },
  );
}

function truncate(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}
