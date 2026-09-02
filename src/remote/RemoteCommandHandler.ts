import type { CompactionOutcome } from '../sidebar/CompactionService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { describeBudget, handleRemoteSessionCommand } from './RemoteSessionCommands';
import {
  sendConversationSelection,
  sendModelSelection,
  sendWorkspaceSelection,
} from './RemoteSelectionPager';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';

export interface RemoteCommandContext {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  host: ForgeHostFacade;
  workspaceId: string;
  signal: AbortSignal;
  inactivityTimeoutMinutes: number;
  modelNames: readonly string[];
  workspaceAliases: Readonly<Record<string, string>>;
  /** The alias whose configured path is this window's root, when one matches. */
  currentWorkspaceAlias?: string | undefined;
  /** Display name of the folder this window has open, alias or not. */
  currentWorkspaceName?: string | undefined;
  /** Per-chat notify_user mute, backed by RemoteController's in-memory set. */
  notifyMute?: { get: (chatId: string) => boolean; set: (chatId: string, on: boolean) => void };
  /** Per-chat turn-echo toggle, backed the same way. Separate from notifyMute
   *  because the two carry very different volumes — see RemoteController. */
  mirrorToggle?: { get: (chatId: string) => boolean; set: (chatId: string, on: boolean) => void };
  switchWorkspace?: ((alias: string, channel: string, chatId: string) => Promise<void>) | undefined;
  setInactivityTimeout?: ((minutes: number) => Promise<void>) | undefined;
  reloadWindow?: (() => Promise<void>) | undefined;
}

export async function handleRemoteCommand(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteCommandContext,
  dedupKey: string,
): Promise<RemoteInboundDisposition> {
  const admission = await context.store.beginControlEvent(dedupKey);
  if (admission === 'completed') return { kind: 'handled' };
  if (admission === 'unknown') {
    return { kind: 'rejected', reason: 'previous command outcome is unknown; resend it' };
  }
  try {
    const result = await executeRemoteCommand(event, context);
    await context.store.finishControlEvent(dedupKey);
    return result;
  } catch (err) {
    await context.store.discardControlEvent(dedupKey);
    throw err;
  }
}

async function executeRemoteCommand(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteCommandContext,
): Promise<RemoteInboundDisposition> {
  // Split whole: `/workspace list 2` needs two operands, and a limit of 2 threw
  // the page number away, so the documented page fallback never paged.
  const [command, ...operands] = event.text.trim().split(/\s+/);
  const argument = operands[0];
  const sessionCommand = await handleRemoteSessionCommand(command, argument, event, context);
  if (sessionCommand) return sessionCommand;
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
        ? 'Forge: clanker mode ON — non-dangerous tools now run with no approval, here or in the sidebar. It does not survive a window reload.'
        : 'Forge: clanker mode OFF — tool approvals are gated again.',
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
  if (command === '/compact') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    const progressId = await context.channel
      .sendProgress?.(event.chatId, 'Forge: compacting…', { signal: context.signal })
      .catch(() => undefined);
    let outcome: CompactionOutcome;
    try {
      outcome = await context.host.compact(binding.conversationId, {
        trigger: 'remote',
        remoteOrigin: { channel: event.channel, chatId: event.chatId },
      });
    } catch (err) {
      // Only a throw from host.compact itself (no outcome available) edits the
      // progress line to failed; the error then flows through the existing
      // command error path below.
      await editProgress(context.channel, event.chatId, progressId, 'Forge: compaction failed.');
      throw err;
    }
    // Edit the progress line from the captured outcome BEFORE the authoritative
    // result send, so a send failure after a successful compaction never
    // displays a false "failed" state.
    await editProgress(
      context.channel,
      event.chatId,
      progressId,
      outcome === 'compacted'
        ? 'Forge: compaction complete.'
        : outcome === 'skipped'
          ? 'Forge: compaction skipped.'
          : 'Forge: compaction failed.',
    );
    const budget = context.host.contextBudget(binding.conversationId);
    await context.channel.send(
      event.chatId,
      `Forge: compaction ${outcome}. Context: ${describeBudget(budget)}`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/workspace') {
    // `list` is the only verb, so requiring it was pure ceremony: bare
    // `/workspace` lists, and `/workspace 2` pages, exactly like /list and
    // /models. The verb still parses so the namespace stays open for the
    // create/confirm subcommands the remote plan has queued behind it.
    const [first, second] = operands;
    const page = first === 'list' ? second : first;
    if (page !== undefined && !/^\d+$/.test(page)) {
      return { kind: 'rejected', reason: 'usage: /workspace [list] [page]' };
    }
    return sendWorkspaceSelection(event, context, page);
  }
  if (command === '/new' && argument) {
    // A number means the last `/workspace list`, matching /model <n> and
    // /resume <n>; the alias keeps working so a remembered name does not
    // depend on having listed first.
    const alias = resolveSelection(context, event, 'workspaces', argument) ?? argument;
    if (!context.workspaceAliases[alias]) {
      // A number that resolves to nothing means the list expired or never ran,
      // not that the workspace is missing — saying “not found” for a number the
      // user just read off a list sends them looking for the wrong problem.
      return { kind: 'rejected', reason: numberedSelectionMiss(context, event, argument) };
    }
    if (!context.switchWorkspace) {
      return { kind: 'rejected', reason: 'workspace switching is unavailable in this window' };
    }
    // Switching costs a window reload and a fresh conversation, so doing it to
    // arrive where the chat already is would silently drop the session.
    if (alias === context.currentWorkspaceAlias) {
      return {
        kind: 'rejected',
        reason: `this chat is already in ${context.workspaceAliases[alias]}; /new alone starts a chat here`,
      };
    }
    // Says what the silence that follows means: the VS Code window reloads, so
    // this chat hears nothing until the new window's transport comes up and
    // sends its own arrival receipt.
    await context.channel.send(
      event.chatId,
      `Forge: switching to ${context.workspaceAliases[alias]}… the window reloads, so this chat goes quiet for a few seconds — I will message you when it is back.`,
      {
        signal: context.signal,
      },
    );
    await context.switchWorkspace(alias, event.channel, event.chatId);
    return { kind: 'handled' };
  }
  if (command === '/new') {
    const conv = await context.host.createConversation({ activate: false });
    await context.store.setBinding({
      channel: event.channel,
      chatId: event.chatId,
      workspaceId: context.workspaceId,
      conversationId: conv.id,
    });
    await context.channel.send(event.chatId, `Forge: bound to a new chat (${shortId(conv.id)}).`, {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  if (command === '/list') {
    return sendConversationSelection(event, context, argument);
  }
  if (command === '/resume' && argument) {
    const conversationId = resolveSelection(context, event, 'conversations', argument) ?? argument;
    const conv = await context.host.restoreConversation(conversationId, { activate: false });
    await context.store.setBinding({
      channel: event.channel,
      chatId: event.chatId,
      workspaceId: context.workspaceId,
      conversationId: conv.id,
    });
    await context.channel.send(
      event.chatId,
      `Forge: resumed ${conv.title} (${shortId(conv.id)}).`,
      {
        signal: context.signal,
      },
    );
    return { kind: 'handled' };
  }
  // Bare /resume used to fall past every branch to “unknown command” — the one
  // answer that is never true here, since the command plainly exists and the
  // help line advertises it. It needs a number, and the numbers come from this
  // list, so printing the list is the whole reply rather than a correction.
  if (command === '/resume') {
    return sendConversationSelection(event, context, undefined);
  }
  if (command === '/models') {
    return sendModelSelection(event, context, argument);
  }
  if (command === '/model' && argument) {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    const status = context.host.status();
    if (
      status.requestChains.some((chain) => chain.conversationId === binding.conversationId) ||
      status.streamingConversationIds.includes(binding.conversationId) ||
      context.store.queued(binding.conversationId).length > 0
    ) {
      return { kind: 'rejected', reason: 'the bound conversation is busy or has queued work' };
    }
    const modelName = resolveSelection(context, event, 'models', argument) ?? argument;
    if (!context.modelNames.includes(modelName)) {
      return { kind: 'rejected', reason: 'model is unavailable; use /models' };
    }
    await context.host.setConversationModel(binding.conversationId, modelName);
    await context.channel.send(event.chatId, `Forge: pinned ${modelName} to this chat.`, {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  // Same defect as bare /resume, and the same answer: /model needs a number
  // from /models, so hand over that list instead of denying the command exists.
  if (command === '/model') {
    return sendModelSelection(event, context, undefined);
  }
  if (command === '/unload') {
    const idleReason = globalBusyReason(context);
    if (idleReason) return { kind: 'rejected', reason: idleReason };
    await context.host.unloadModels();
    await context.channel.send(
      event.chatId,
      'Forge: all models unloaded, memory released. Send a prompt to start the backend again.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/restart') {
    const idleReason = globalBusyReason(context);
    if (idleReason) return { kind: 'rejected', reason: idleReason };
    const binding = context.store.binding(event.channel, event.chatId);
    const modelName = binding
      ? context.host.status().conversations.find((item) => item.id === binding.conversationId)
          ?.activeModel
      : undefined;
    if (!modelName) {
      return {
        kind: 'rejected',
        reason: 'this chat has no explicitly pinned model; use /models then /model',
      };
    }
    await context.host.restartModel(modelName);
    await context.channel.send(event.chatId, `Forge: restarted ${modelName}.`, {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  return { kind: 'rejected', reason: 'unknown command' };
}

/** Best-effort edit of a progress message; silently skipped when unsupported. */
async function editProgress(
  channel: RemoteChannel,
  chatId: string,
  messageId: string | undefined,
  text: string,
): Promise<void> {
  if (!messageId || !channel.editMessage) return;
  await channel.editMessage(chatId, messageId, text).catch(() => undefined);
}

function globalBusyReason(context: RemoteCommandContext): string | undefined {
  const status = context.host.status();
  if (
    status.requestChains.length ||
    status.streamingConversationIds.length ||
    status.pendingApproval
  ) {
    return 'Forge is busy; wait for requests, streams, and approvals to finish';
  }
  return context.store.queued().length > 0 ? 'Forge has queued remote requests' : undefined;
}

function resolveSelection(
  context: RemoteCommandContext,
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  kind: 'models' | 'conversations' | 'workspaces',
  argument: string,
): string | undefined {
  if (!/^\d+$/.test(argument)) return undefined;
  const selection = context.store.selection(event.channel, event.chatId, kind);
  const index = Number(argument) - 1;
  return selection && index >= 0 && index < selection.values.length
    ? selection.values[index]
    : undefined;
}

/** Why `/new <number>` found nothing: an expired list, an out-of-range number,
 *  or a genuinely unknown alias are three different fixes. */
function numberedSelectionMiss(
  context: RemoteCommandContext,
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  argument: string,
): string {
  if (!/^\d+$/.test(argument)) {
    return `workspace “${argument}” was not found. Use /workspace.`;
  }
  const selection = context.store.selection(event.channel, event.chatId, 'workspaces');
  if (!selection) return 'the workspace list expired; run /workspace again, then /new <number>';
  return `pick 1-${selection.values.length} from the last /workspace list`;
}

function shortId(id: string): string {
  return id.length > 7 ? `${id.slice(0, 3)}…${id.slice(-3)}` : id;
}
