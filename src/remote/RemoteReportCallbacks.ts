import type { RemoteCommandContext } from './RemoteCommandHandler';
import type { RemoteAgentAsk } from './remoteAgentAsk';
import { telegramJobHash } from './TelegramJobButtons';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;
type ButtonEvent = Extract<
  RemoteInboundEvent,
  { kind: 'selection' | 'job_action' | 'queue_action' | 'agent_ask_action' }
>;

export interface RemoteReportCallbackDeps {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  agentAsk: RemoteAgentAsk;
  commandContext: (event: TextEvent) => RemoteCommandContext;
  routeText: (
    event: TextEvent,
    overrides?: Pick<RemoteCommandContext, 'telegramEditMessageId' | 'telegramJobTarget'>,
  ) => Promise<RemoteInboundDisposition>;
}

/** Routes report buttons into the existing selection and owner-command paths. */
export async function handleRemoteReportCallback(
  event: ButtonEvent,
  deps: RemoteReportCallbackDeps,
): Promise<RemoteInboundDisposition | undefined> {
  if (event.kind === 'selection') {
    if (event.action !== 'pick') return undefined;
    const selection = deps.store.selection(
      event.channel,
      event.chatId,
      event.selectionKind,
      event.selectionToken,
    );
    if (!selection) {
      const command =
        event.selectionKind === 'conversations'
          ? '/chats'
          : event.selectionKind === 'models'
            ? '/models'
            : '/workspace';
      return {
        kind: 'rejected',
        reason: `${event.selectionKind} list expired; run ${command} again`,
      };
    }
    if (event.index === undefined || event.index >= selection.values.length) {
      return { kind: 'rejected', reason: 'selection index is out of range' };
    }
    const command =
      event.selectionKind === 'conversations'
        ? '/chat'
        : event.selectionKind === 'models'
          ? '/model'
          : '/workspace';
    return deps.routeText(textEvent(event, `${command} ${event.index + 1}`));
  }
  if (event.kind === 'agent_ask_action') {
    if (!deps.channel.sendForceReply) {
      return { kind: 'rejected', reason: 'Telegram force reply is unavailable' };
    }
    const title = titleCase(event.agentKind);
    try {
      const messageId = await deps.channel.sendForceReply(
        event.chatId,
        `Question for ${title}:`,
        `Ask ${title}…`,
      );
      if (!messageId)
        return { kind: 'rejected', reason: 'Telegram did not return the question message id' };
      deps.agentAsk.remember(event.chatId, messageId, event.agentKind);
      return { kind: 'handled' };
    } catch (err) {
      return {
        kind: 'rejected',
        reason: `Could not send the question: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (event.kind === 'queue_action') {
    const argument = event.all ? 'all' : event.requestId;
    if (!argument) return { kind: 'rejected', reason: 'queue callback is invalid' };
    return deps.routeText(textEvent(event, `/drop ${argument}`), {
      telegramEditMessageId: event.messageId,
    });
  }
  return routeJobCallback(event, deps);
}

async function routeJobCallback(
  event: Extract<RemoteInboundEvent, { kind: 'job_action' }>,
  deps: RemoteReportCallbackDeps,
): Promise<RemoteInboundDisposition> {
  const context = deps.commandContext(textEvent(event, '/jobs'));
  const jobs = context.jobs;
  if (!jobs?.enabled) return { kind: 'rejected', reason: 'jobs are unavailable' };
  const all = await jobs.store.loadAll();
  const jobFile = all[event.index];
  if (!jobFile || telegramJobHash(jobFile.job.id) !== event.hash) {
    await deps.channel.send(event.chatId, 'The job list changed. Run /jobs again.', {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  const target = {
    index: event.index,
    hash: event.hash,
    messageId: event.messageId,
    action: event.action,
  };
  if (event.action === 'show' || event.action === 'l') {
    return deps.routeText(textEvent(event, '/jobs'), {
      telegramEditMessageId: event.messageId,
      telegramJobTarget: target,
    });
  }
  const action =
    event.action === 'r'
      ? 'run'
      : event.action === 'p'
        ? 'pause'
        : event.action === 'u'
          ? 'resume'
          : event.action === 'c'
            ? 'chat'
            : event.action === 'd' || event.action === 'D'
              ? 'delete'
              : undefined;
  if (!action) return { kind: 'rejected', reason: 'job callback is invalid' };
  return deps.routeText(
    textEvent(event, `/job ${event.index + 1} ${action}${event.action === 'D' ? ' confirm' : ''}`),
    { telegramEditMessageId: event.messageId, telegramJobTarget: target },
  );
}

function textEvent(
  event: Exclude<ButtonEvent, { kind: 'agent_ask_action' }>,
  text: string,
): TextEvent {
  return {
    channel: event.channel,
    kind: 'text',
    providerMessageId: event.providerMessageId,
    callbackMessageId: event.messageId,
    senderId: event.senderId,
    chatId: event.chatId,
    chatType: event.chatType,
    receivedAt: event.receivedAt,
    text,
  };
}

function titleCase(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
