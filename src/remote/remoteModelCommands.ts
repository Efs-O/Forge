import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { collectSystemReport } from '../system/SystemReport';
import { formatSystemReport } from '../system/formatSystemReport';
import { modelPickerSelectionEntries } from '../sidebar/ModelPickerGroups';
import { sendModelSelection } from './RemoteSelectionPager';
import { sendModelProfileSelection } from './RemoteModelProfileSelection';
import { resolveModelSelection } from './remoteCommandSelectors';
import { globalBusyReason } from './remoteCommandShared';
import type { RemoteCommandContext } from './RemoteCommandHandler';

/**
 * The model-management remote commands: `/models`, `/model`, `/system`,
 * `/unload`, `/unloadall`, and `/restart`. Returns a disposition when the
 * command is one of these, or `undefined` to let the next handler in the chain
 * take it.
 */
export async function handleRemoteModelCommand(
  command: string,
  argument: string | undefined,
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteCommandContext,
): Promise<RemoteInboundDisposition | undefined> {
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
    const modelName = resolveModelSelection(context, event, argument);
    if (
      !modelName ||
      !modelPickerSelectionEntries(context.modelEntries).some((model) => model.name === modelName)
    ) {
      return { kind: 'rejected', reason: 'model is unavailable; use /models' };
    }
    const baseEntry = context.modelEntries.find((model) => model.name === modelName);
    if (baseEntry?.profiles?.length && !modelName.includes('@')) {
      return sendModelProfileSelection(event, context, modelName);
    }
    await context.host.setConversationModel(binding.conversationId, modelName);
    await context.channel.send(event.chatId, `Forge: pinned ${modelName} to this chat.`, {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  // /model with no argument lists the models, the way /chats and /workspace do
  // with no argument — a bare command is a request to see the list, not a
  // failed pick.
  if (command === '/model') {
    return sendModelSelection(event, context, undefined);
  }
  if (command === '/system') {
    // Deliberately not gated on a busy window: "what is holding the VRAM" is
    // the question a user asks precisely while a turn is running, and the
    // probes read counters without touching anything the turn owns.
    const report = await collectSystemReport({
      backendProcesses: () => context.host.backendProcesses?.() ?? [],
    });
    const text = formatSystemReport(report, {
      compact: true,
      telegramHtml: context.channel.sendHtml !== undefined,
    });
    if (context.channel.sendHtml) {
      await context.channel.sendHtml(event.chatId, text, { signal: context.signal });
    } else {
      await context.channel.send(event.chatId, text, { signal: context.signal });
    }
    return { kind: 'handled' };
  }
  if (command === '/unload') {
    const idleReason = globalBusyReason(context);
    if (idleReason) return { kind: 'rejected', reason: idleReason };
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) {
      return { kind: 'rejected', reason: 'this chat has no conversation; use /unloadall' };
    }
    const { model, wasLoaded } = await context.host.unloadConversationModel(binding.conversationId);
    const text = wasLoaded
      ? `Forge: ${model} unloaded, memory released. Other loaded models stay; /unloadall frees them too.`
      : `Forge: ${model} was not loaded.`;
    await context.channel.send(event.chatId, text, { signal: context.signal });
    return { kind: 'handled' };
  }
  if (command === '/unloadall') {
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
  return undefined;
}
