import { randomUUID } from 'crypto';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteAttachmentStore } from './RemoteAttachmentStore';
import type { RemoteAuditLog } from './RemoteAuditLog';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type {
  RemoteChannel,
  RemoteInboundDisposition,
  RemoteInboundEvent,
  RemoteRequestRecord,
} from './types';

export interface RemotePromptAdmissionOptions {
  workspaceId: string;
  queueLimit: number;
  attachmentsEnabled: boolean;
  acceptPdfAttachments: boolean;
  attachmentStore?: RemoteAttachmentStore | undefined;
}

export interface RemotePromptAdmissionDeps {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  host: ForgeHostFacade;
  options: RemotePromptAdmissionOptions;
  isBusy: (conversationId: string) => boolean;
  kickDrain: (conversationId: string) => void;
  audit?: RemoteAuditLog | undefined;
  onError?: ((message: string) => void) | undefined;
}

export interface SteerCommand {
  matched: boolean;
  text?: string | undefined;
}

/** Recognise `/steer <prompt>` without treating an ordinary slash command as a prompt. */
export function parseSteerCommand(text: string): SteerCommand {
  const match = /^\/steer(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return { matched: false };
  const prompt = match[1]?.trim();
  return prompt ? { matched: true, text: prompt } : { matched: true };
}

/** Durable prompt admission shared by ordinary and priority steering messages. */
export async function admitRemotePrompt(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  text: string,
  dedupKey: string,
  priority: RemoteRequestRecord['priority'],
  deps: RemotePromptAdmissionDeps,
): Promise<RemoteInboundDisposition> {
  const duplicate = deps.store.getByDedupKey(dedupKey);
  if (duplicate) {
    return { kind: 'duplicate', requestId: duplicate.id, state: duplicate.state };
  }
  let binding = deps.store.binding(event.channel, event.chatId);
  if (binding && binding.workspaceId !== deps.options.workspaceId) {
    return { kind: 'rejected', reason: 'chat is bound to a different workspace' };
  }
  if (!binding) {
    const conversation = await deps.host.createConversation({ activate: false });
    binding = {
      channel: event.channel,
      chatId: event.chatId,
      workspaceId: deps.options.workspaceId,
      conversationId: conversation.id,
    };
    await deps.store.setBinding(binding);
  }
  const alreadyQueued = deps.store.queued(binding.conversationId);
  if (alreadyQueued.length >= deps.options.queueLimit) {
    return { kind: 'rejected', reason: 'remote queue is full' };
  }
  const busy = deps.isBusy(binding.conversationId);
  const requestId = randomUUID();
  let attachments: RemoteRequestRecord['attachments'];
  try {
    attachments = await saveAttachments(event, binding.conversationId, requestId, deps);
  } catch (err) {
    return { kind: 'rejected', reason: `attachment rejected: ${(err as Error).message}` };
  }
  const request: RemoteRequestRecord = {
    id: requestId,
    dedupKey,
    channel: event.channel,
    chatId: event.chatId,
    providerMessageId: event.providerMessageId,
    conversationId: binding.conversationId,
    text,
    ...(priority ? { priority } : {}),
    ...(attachments ? { attachments } : {}),
    receivedAt: event.receivedAt,
    admittedAt: Date.now(),
    state: 'queued',
    updatedAt: Date.now(),
  };
  try {
    const inserted = await deps.store.enqueue(request);
    if (!inserted) {
      const existing = deps.store.getByDedupKey(dedupKey);
      if (!existing) return { kind: 'retry', reason: 'dedup state changed during admission' };
      return { kind: 'duplicate', requestId: existing.id, state: existing.state };
    }
  } catch (err) {
    return { kind: 'retry', reason: `durable admission failed: ${(err as Error).message}` };
  }

  if (busy) deps.host.queueIntent(binding.conversationId);
  await deps.audit
    ?.record(
      event,
      priority === 'steer' ? 'steer_queued' : busy ? 'request_queued' : 'request_accepted',
      request.id,
    )
    .catch(() => undefined);
  if (busy && priority === 'steer') {
    await deps.host.interrupt(binding.conversationId).catch((err) => {
      deps.onError?.(
        `Forge remote steering interrupt failed; prompt remains queued: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
  deps.kickDrain(request.conversationId);
  const position =
    deps.store.queued(binding.conversationId).findIndex((item) => item.id === request.id) + 1;
  return busy || alreadyQueued.length > 0
    ? { kind: 'queued', requestId: request.id, position: Math.max(1, position) }
    : { kind: 'accepted', requestId: request.id };
}

async function saveAttachments(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  conversationId: string,
  requestId: string,
  deps: RemotePromptAdmissionDeps,
): Promise<RemoteRequestRecord['attachments']> {
  if (!event.attachments?.length) return undefined;
  if (!deps.options.attachmentsEnabled) {
    throw new Error('remote attachments are disabled in Forge configuration');
  }
  if (!deps.options.attachmentStore) {
    throw new Error('remote attachments require an open workspace');
  }
  const inbound = await Promise.all(
    event.attachments.map(async (attachment) => {
      if (attachment.mediaType === 'application/pdf' && !deps.options.acceptPdfAttachments) {
        throw new Error('PDF attachments are disabled in Forge configuration');
      }
      if (attachment.data) return attachment;
      if (!deps.channel.downloadAttachment)
        throw new Error('transport cannot download attachments');
      return deps.channel.downloadAttachment(attachment);
    }),
  );
  return deps.options.attachmentStore.save(conversationId, requestId, inbound);
}
