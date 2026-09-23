import { modelPickerSelectionEntries } from '../sidebar/ModelPickerGroups';
import type { RemoteSelectionContext } from './RemoteSelectionPager';
import { SELECTION_TTL_MS } from './RemoteSelectionConstants';
import type { RemoteInboundEvent, RemoteInboundDisposition } from './types';

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;
type SelectionEvent = Extract<RemoteInboundEvent, { kind: 'selection' }>;

/** Sends the second step of Telegram's `/model <number>` picker. */
export async function sendModelProfileSelection(
  event: TextEvent,
  context: RemoteSelectionContext,
  modelName: string,
): Promise<RemoteInboundDisposition> {
  const descriptor = context.modelEntries.find((model) => model.name === modelName);
  const profiles = descriptor?.profiles ?? [];
  if (profiles.length === 0) return { kind: 'rejected', reason: 'model has no profiles' };
  const sendChoices = context.channel.selectionPages?.sendChoices;
  if (!sendChoices) {
    await context.channel.send(
      event.chatId,
      `Forge: choose a profile for ${modelName}: ${profiles.map((p) => `@${p}`).join(', ')}`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  // Every choice is a profile: a model that has profiles is always run through one.
  const values = profiles.map((profile) => `${modelName}@${profile}`);
  const token = await context.store.issueSelection(
    event.channel,
    event.chatId,
    'models',
    values,
    SELECTION_TTL_MS,
  );
  await sendChoices(
    event.chatId,
    `Forge: choose a profile for ${modelName}.`,
    profiles.map((profile, index) => ({ label: `@${profile}`, value: index })),
    { kind: 'models', token, page: 0, pageCount: 1 },
    { signal: context.signal },
  );
  return { kind: 'handled' };
}

export async function selectModelProfile(
  event: SelectionEvent,
  context: RemoteSelectionContext,
): Promise<RemoteInboundDisposition> {
  if (event.selectionKind !== 'models' || event.choice === undefined) {
    return { kind: 'rejected', reason: 'profile choice is invalid' };
  }
  const selection = context.store.selection(
    event.channel,
    event.chatId,
    event.selectionKind,
    event.selectionToken,
  );
  if (!selection || event.choice >= selection.values.length) {
    return { kind: 'rejected', reason: 'profile choice expired; run /model again' };
  }
  const modelName = selection.values[event.choice]!;
  if (
    !modelPickerSelectionEntries(context.modelEntries).some((model) => model.name === modelName)
  ) {
    return { kind: 'rejected', reason: 'profile choice is no longer available; run /models again' };
  }
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
  await context.host.setConversationModel(binding.conversationId, modelName);
  await context.store.clearSelection(
    event.channel,
    event.chatId,
    event.selectionKind,
    event.selectionToken,
  );
  if (context.channel.selectionPages) {
    await context.channel.selectionPages.close(event.chatId, event.messageId, {
      signal: context.signal,
    });
  }
  await context.channel.send(event.chatId, `Forge: pinned ${modelName} to this chat.`, {
    signal: context.signal,
  });
  return { kind: 'handled' };
}
