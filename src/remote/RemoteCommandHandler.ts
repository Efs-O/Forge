import type { CompactionOutcome } from '../sidebar/CompactionService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
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
  switchWorkspace?: ((alias: string, channel: string, chatId: string) => Promise<void>) | undefined;
  setInactivityTimeout?: ((minutes: number) => Promise<void>) | undefined;
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

/** `max` is the PER-SLOT window; a model with no resolvable num_ctx reports none. */
function describeBudget(budget: { used: number; max: number } | undefined): string {
  if (!budget || budget.max <= 0) return 'unavailable (no num_ctx for this model)';
  const percent = Math.round((budget.used / budget.max) * 100);
  return `${budget.used}/${budget.max} tokens (${percent}%)`;
}

async function executeRemoteCommand(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteCommandContext,
): Promise<RemoteInboundDisposition> {
  const [command, argument] = event.text.trim().split(/\s+/, 2);
  if (command === '/help') {
    await context.channel.send(
      event.chatId,
      'Forge commands: /status, /stop, /new, /list, /resume <number-or-id>, /models, ' +
        '/model <number-or-name>, /queue, /unload, /restart, /compact, /lock, ' +
        '/timeout [1-1440|off], /clanker on|off. /stop cancels the current request; queued requests remain ' +
        'queued. /clanker on auto-approves non-dangerous tools until this window ' +
        'reloads — writes then land with no confirmation anywhere.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/status') {
    const status = context.host.status();
    const binding = context.store.binding(event.channel, event.chatId);
    const queued = binding ? context.store.queued(binding.conversationId).length : 0;
    const requests = context.store.requestHealth();
    const outbox = context.store.outboxHealth();
    const conversation = status.conversations.find((item) => item.id === binding?.conversationId);
    await context.channel.send(
      event.chatId,
      `Chat: ${conversation ? `${conversation.title} · ${conversation.id}` : 'none bound'}\n` +
        `Model: ${conversation?.activeModel ?? 'default'}\n` +
        `Forge: ${status.requestChains.length} active request(s), ${queued} queued here, ${status.streamingConversationIds.length} streaming, ${requests.unknown} crash-unknown, ${outbox.pending} notifications pending, ${outbox.abandoned} abandoned.
` +
        `Context: ${describeBudget(binding && context.host.contextBudget(binding.conversationId))}
` +
        // Stated on every /status, not only when asked: a remote owner cannot
        // see the sidebar, and not knowing whether writes are gated is the one
        // thing they must never have to guess.
        `Approvals: ${context.host.clankerMode() ? 'CLANKER — non-dangerous tools auto-approved' : 'gated'}`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
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
  if (command === '/workspace' && argument === 'list') {
    const entries = Object.entries(context.workspaceAliases);
    await context.channel.send(
      event.chatId,
      entries.length === 0
        ? 'Forge: no remote workspace aliases are configured.'
        : entries.map(([alias, display]) => `${alias} — ${display}`).join('\n'),
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/new' && argument) {
    if (!context.workspaceAliases[argument] || !context.switchWorkspace) {
      return {
        kind: 'rejected',
        reason: `workspace “${argument}” was not found. Use /workspace list.`,
      };
    }
    await context.channel.send(
      event.chatId,
      `Forge: switching to ${context.workspaceAliases[argument]}…`,
      {
        signal: context.signal,
      },
    );
    await context.switchWorkspace(argument, event.channel, event.chatId);
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
    const conversations = context.host
      .status()
      .conversations.slice()
      .sort((left, right) => right.updatedAt - left.updatedAt);
    if (conversations.length === 0) {
      await context.channel.send(event.chatId, 'Forge: no conversations are available.', {
        signal: context.signal,
      });
      return { kind: 'handled' };
    }
    await context.store.issueSelection(
      event.channel,
      event.chatId,
      'conversations',
      conversations.map((conversation) => conversation.id),
      10 * 60_000,
    );
    await context.channel.send(
      event.chatId,
      conversations
        .map(
          (conversation, index) =>
            `${index + 1}. ${conversation.title} · ${shortId(conversation.id)} · ${
              conversation.activeModel ?? 'default model'
            } · ${formatActivity(conversation.updatedAt)}${conversation.archived ? ' · archived' : ''}`,
        )
        .join('\n'),
      { signal: context.signal },
    );
    return { kind: 'handled' };
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
  if (command === '/models') {
    if (context.modelNames.length === 0) {
      return { kind: 'rejected', reason: 'no configured models are available' };
    }
    await context.store.issueSelection(
      event.channel,
      event.chatId,
      'models',
      [...context.modelNames],
      10 * 60_000,
    );
    await context.channel.send(
      event.chatId,
      context.modelNames.map((name, index) => `${index + 1}. ${name}`).join('\n'),
      { signal: context.signal },
    );
    return { kind: 'handled' };
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
  if (command === '/queue') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    const queued = context.store.queued(binding.conversationId);
    await context.channel.send(
      event.chatId,
      queued.length === 0
        ? 'Forge: no queued prompts for this chat.'
        : queued.map((item, index) => `${index + 1}. ${truncate(item.text, 160)}`).join('\n'),
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/unload') {
    const idleReason = globalBusyReason(context);
    if (idleReason) return { kind: 'rejected', reason: idleReason };
    await context.host.unloadModels();
    await context.channel.send(event.chatId, 'Forge: loaded backends released.', {
      signal: context.signal,
    });
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
  kind: 'models' | 'conversations',
  argument: string,
): string | undefined {
  if (!/^\d+$/.test(argument)) return undefined;
  const selection = context.store.selection(event.channel, event.chatId, kind);
  const index = Number(argument) - 1;
  return selection && index >= 0 && index < selection.values.length
    ? selection.values[index]
    : undefined;
}

function shortId(id: string): string {
  return id.length > 7 ? `${id.slice(0, 3)}…${id.slice(-3)}` : id;
}

function formatActivity(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
}

function truncate(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}
