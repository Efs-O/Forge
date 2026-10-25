import { escapeTelegramHtml } from './telegramHtml';
import { contextPercent, formatContextUsage, formatTokensShort } from './telegramReportFormat';
import type { RemoteCommandContext } from './RemoteCommandHandler';
import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { telegramCommandButton } from './TelegramCommandButtons';
import { telegramCloseButton } from './TelegramHelpButtons';
import { getBoardContext } from '../agentMesh/meshContext';
import { readEvents, type ExchangeEvent } from '../agentMesh/exchangeLog';

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

export interface RemoteStatusReportInput {
  workspaceName?: string | undefined;
  workspaceAlias?: string | undefined;
  conversation?:
    | {
        id: string;
        title: string;
        activeModel: string | null;
        requestCount: number;
        toolCallCount: number;
        compactCount: number;
        activeMs: number;
      }
    | undefined;
  running: number;
  queued: number;
  streaming: number;
  crashUnknown?: number | undefined;
  notificationsPending: number;
  abandoned: number;
  context?: { used: number; max: number } | undefined;
  clanker: boolean;
  exchanges: string;
}

export interface RemoteReportText {
  html: string;
  plain: string;
}

export interface RemoteContextReportInput {
  model: string;
  budget?: { used: number; max: number } | undefined;
  breakdown?: { instructions: number; tools: number; conversation: number } | undefined;
  compactAt?: number | undefined;
}

export function remoteQueueForChat(
  event: TextEvent,
  context: RemoteCommandContext,
  conversationId: string,
) {
  return context.store
    .queued(conversationId)
    .filter((item) => item.channel === event.channel && item.chatId === event.chatId);
}

/** Owns `/status` and `/context` presentation while leaving `describeWork` untouched. */
export async function handleRemoteStatusReportCommand(
  command: string,
  event: TextEvent,
  context: RemoteCommandContext,
): Promise<RemoteInboundDisposition | undefined> {
  if (command === '/status') {
    const status = context.host.status();
    const binding = context.store.binding(event.channel, event.chatId);
    const queued = binding ? remoteQueueForChat(event, context, binding.conversationId).length : 0;
    const outbox = context.store.outboxHealth();
    const conversation = status.conversations.find((item) => item.id === binding?.conversationId);
    const crashUnknown = binding
      ? context.store.requestHealthForConversation(binding.conversationId).unknown
      : undefined;
    const report = renderRemoteStatusReport({
      workspaceName: context.currentWorkspaceName,
      workspaceAlias: context.currentWorkspaceAlias,
      conversation,
      running: status.requestChains.length,
      queued,
      streaming: status.streamingConversationIds.length,
      ...(crashUnknown === undefined ? {} : { crashUnknown }),
      notificationsPending: outbox.pending,
      abandoned: outbox.abandoned,
      context: binding ? context.host.contextBudget(binding.conversationId) : undefined,
      clanker: context.host.clankerMode(),
      exchanges: describeAgentBoard(binding?.conversationId) ?? 'Exchanges: none',
    });
    if (context.channel.parseMode && context.channel.sendInlineKeyboard) {
      const buttons = [
        [
          telegramCommandButton('context', 'Context'),
          telegramCommandButton('system', 'System'),
          telegramCommandButton('chats', 'Chats'),
        ],
        [telegramCloseButton()],
      ];
      if (context.telegramEditMessageId && context.channel.editInlineKeyboardMessage) {
        await context.channel.editInlineKeyboardMessage(
          event.chatId,
          context.telegramEditMessageId,
          report.html,
          buttons,
          {
            signal: context.signal,
            parseMode: 'HTML',
          },
        );
      } else {
        await context.channel.sendInlineKeyboard(event.chatId, report.html, buttons, {
          signal: context.signal,
          parseMode: 'HTML',
        });
      }
    } else {
      await context.channel.send(event.chatId, report.plain, { signal: context.signal });
    }
    return { kind: 'handled' };
  }
  if (command !== '/context') return undefined;
  const binding = context.store.binding(event.channel, event.chatId);
  if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
  const conversation = context.host
    .status()
    .conversations.find((item) => item.id === binding.conversationId);
  const report = renderRemoteContextReport({
    model: conversation?.activeModel ?? 'default',
    budget: context.host.contextBudget(binding.conversationId),
    breakdown: context.host.contextBreakdown(binding.conversationId),
  });
  if (context.channel.parseMode && context.channel.sendInlineKeyboard) {
    const buttons = [[telegramCommandButton('compact', 'Compact now')], [telegramCloseButton()]];
    if (context.telegramEditMessageId && context.channel.editInlineKeyboardMessage) {
      await context.channel.editInlineKeyboardMessage(
        event.chatId,
        context.telegramEditMessageId,
        report.html,
        buttons,
        {
          signal: context.signal,
          parseMode: 'HTML',
        },
      );
    } else {
      await context.channel.sendInlineKeyboard(event.chatId, report.html, buttons, {
        signal: context.signal,
        parseMode: 'HTML',
      });
    }
  } else {
    await context.channel.send(event.chatId, report.plain, { signal: context.signal });
  }
  return { kind: 'handled' };
}

/** Recent exchanges for `/status`, scoped to this chat's bound conversation. */
function describeAgentBoard(conversation: string | undefined): string | undefined {
  const ctx = getBoardContext();
  if (!ctx || conversation === undefined) return undefined;
  const latest = new Map<string, ExchangeEvent>();
  for (const event of readEvents(ctx.log)) {
    if (event.workspace !== ctx.workspace || event.conversation !== conversation) continue;
    const prior = latest.get(event.exchangeId);
    if (!prior || event.seq > prior.seq) latest.set(event.exchangeId, event);
  }
  const rows = [...latest.values()].sort((left, right) => right.seq - left.seq).slice(0, 3);
  return rows.length === 0
    ? 'Exchanges: none'
    : `Exchanges: ${rows.map((row) => `${row.from}${row.to ? `→${row.to}` : ''} ${row.state}`).join(', ')}`;
}

/** Phone-first `/status`, with parallel plain text for transports without HTML. */
export function renderRemoteStatusReport(input: RemoteStatusReportInput): RemoteReportText {
  const workspace = `${input.workspaceName ?? 'unknown'}${input.workspaceAlias ? ` (${input.workspaceAlias})` : ''}`;
  const chat = input.conversation
    ? `${clip(input.conversation.title, 40)} · ${input.conversation.id.slice(0, 8)}`
    : 'No chat bound';
  const model = input.conversation?.activeModel ?? 'default';
  const activity = [
    part(input.running, 'running'),
    part(input.queued, 'queued here'),
    part(input.streaming, 'streaming'),
  ].filter((value): value is string => value !== undefined);
  const problems = [
    input.crashUnknown ? part(input.crashUnknown, 'crash-unknown') : undefined,
    part(input.notificationsPending, 'notifications pending'),
    part(input.abandoned, 'abandoned'),
  ].filter((value): value is string => value !== undefined);
  const now =
    activity.length === 0 && problems.length === 0
      ? 'Idle · nothing queued'
      : activity.length > 0
        ? activity.join(' · ')
        : 'Idle';
  const problemLine = problems.length > 0 ? problems.join(' · ') : undefined;
  const budget = input.context;
  const contextUsage =
    budget && budget.max > 0 ? formatContextUsage(budget.used, budget.max) : undefined;
  const contextPercentUsed =
    budget && budget.max > 0 ? contextPercent(budget.used, budget.max) : undefined;
  const contextHtml =
    budget && budget.max > 0
      ? `<b>Context</b>\n${escapeTelegramHtml(contextUsage ?? '')}`
      : '<b>Context</b>\nContext unavailable (no num_ctx for this model)';
  const contextPlain =
    budget && budget.max > 0
      ? `Context\n${contextUsage ?? ''}`
      : 'Context\nContext unavailable (no num_ctx for this model)';
  const work = formatWork(input.conversation);
  const approvalsHtml = input.clanker
    ? '<b>Approvals: CLANKER</b> — non-dangerous tools auto-approved'
    : `<i>Approvals: gated · ${escapeTelegramHtml(input.exchanges)}</i>`;
  const approvalsPlain = input.clanker
    ? 'Approvals: CLANKER — non-dangerous tools auto-approved'
    : `Approvals: gated · ${input.exchanges}`;
  const html = [
    `<b>Status</b>${contextPercentUsed === undefined ? '' : ` · Context ${contextPercentUsed}%`}`,
    `<b>Workspace</b> ${escapeTelegramHtml(workspace)}`,
    `<b>Chat</b> ${escapeTelegramHtml(chat)}`,
    `<b>Model</b> ${escapeTelegramHtml(model)}`,
    `<b>Now</b> ${escapeTelegramHtml(now)}`,
    ...(problemLine ? [escapeTelegramHtml(problemLine)] : []),
    contextHtml,
    ...(work ? [`<b>Work</b> ${escapeTelegramHtml(work)}`] : []),
    approvalsHtml,
  ].join('\n');
  const plain = [
    `Status${contextPercentUsed === undefined ? '' : ` · Context ${contextPercentUsed}%`}`,
    `Workspace ${workspace}`,
    `Chat ${chat}`,
    `Model ${model}`,
    `Now ${now}`,
    ...(problemLine ? [problemLine] : []),
    contextPlain,
    ...(work ? [`Work ${work}`] : []),
    approvalsPlain,
  ].join('\n');
  return { html, plain };
}

/** `/context` total and measured transcript estimates. */
export function renderRemoteContextReport(input: RemoteContextReportInput): RemoteReportText {
  const budget = input.budget;
  const heading = `<b>Context</b> <i>· ${escapeTelegramHtml(input.model)}</i>`;
  const plainHeading = `Context · ${input.model}`;
  if (!budget || budget.max <= 0) {
    const unavailable = 'Context unavailable (no num_ctx for this model)';
    return { html: `${heading}\n${unavailable}`, plain: `${plainHeading}\n${unavailable}` };
  }
  const percent = Math.round((budget.used / budget.max) * 100);
  const total = formatContextUsage(budget.used, budget.max) ?? `${percent}%`;
  const plainTotal = total;
  const threshold = input.compactAt;
  const footer =
    threshold !== undefined
      ? `Auto-compaction at ${Math.round(threshold * 100)}% (${formatTokensShort(budget.max * threshold)}).`
      : 'Estimates. Auto-compaction runs at the configured threshold.';
  const parts = input.breakdown;
  if (!parts) {
    return {
      html: `${heading}\n${escapeTelegramHtml(total)}\n<i>${escapeTelegramHtml(footer)}</i>`,
      plain: `${plainHeading}\n${plainTotal}\n${footer}`,
    };
  }
  const rows = [
    ['Instructions', parts.instructions],
    ['Tools', parts.tools],
    ['Conversation', parts.conversation],
  ] as const;
  const renderedRows = rows.map(
    ([label, count]) => `${label.padEnd(13)} ${formatTokensShort(count).padStart(4)}`,
  );
  const breakdownHtml = `<b>What fills it</b>\n${renderedRows.map(escapeTelegramHtml).join('\n')}`;
  const breakdownPlain = `What fills it\n${renderedRows.join('\n')}`;
  return {
    html: `${heading}\n${escapeTelegramHtml(total)}\n${breakdownHtml}\n<i>${escapeTelegramHtml(footer)}</i>`,
    plain: `${plainHeading}\n${plainTotal}\n${breakdownPlain}\n${footer}`,
  };
}

function formatWork(conversation: RemoteStatusReportInput['conversation']): string {
  if (!conversation) return '';
  const values = [
    conversation.activeMs > 0 ? `${formatDuration(conversation.activeMs)} active` : undefined,
    part(conversation.requestCount, 'request'),
    part(conversation.toolCallCount, 'tool call'),
    part(conversation.compactCount, 'compaction'),
  ].filter((value): value is string => value !== undefined);
  return values.join(' · ');
}

function part(count: number, label: string): string | undefined {
  return count > 0
    ? `${count} ${label}${count === 1 || label.endsWith('here') || label.endsWith('ing') ? '' : 's'}`
    : undefined;
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

function clip(value: string, max: number): string {
  const chars = [...value.replace(/[\r\n]+/gu, ' ')];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}
