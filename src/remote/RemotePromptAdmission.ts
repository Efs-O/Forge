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

interface RemoteResumeDeps extends RemotePromptAdmissionDeps {
  restoreConversation: (conversationId: string) => Promise<unknown>;
}

export interface SteerCommand {
  matched: boolean;
  /** New prompt text to run ahead of the queue. */
  text?: string | undefined;
  /** 1-based queue position to promote instead of enqueuing new text. */
  promote?: number | undefined;
}

/**
 * Recognise `/steer` in both of its forms without treating an ordinary slash
 * command as a prompt.
 *
 * A bare number is a queue position, never prompt text. `/drop 1` takes an
 * index, so `/steer 1` reading as the literal one-character prompt "1" was a
 * trap that cost real turns: it cancelled the running turn and then asked the
 * agent to act on "1". The two commands now agree on what a number means, and
 * every caller reports which reading it took.
 */
export function parseSteerCommand(text: string): SteerCommand {
  const match = /^\/steer(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return { matched: false };
  const argument = match[1]?.trim();
  if (!argument) return { matched: true, promote: 1 };
  if (/^\d+$/.test(argument)) return { matched: true, promote: Number(argument) };
  return { matched: true, text: argument };
}

/**
 * True when inbound text is a control command rather than work for the agent.
 *
 * `/steer` is deliberately NOT one: it carries a prompt, so every rule that
 * protects a prompt — holding it across a TOTP challenge, durable queue
 * admission — has to apply to it too.
 */
export function isRemoteCommand(text: string): boolean {
  return text.trim().startsWith('/') && !parseSteerCommand(text).matched;
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

/**
 * Route one inbound text message to the queue.
 *
 * Sole owner of what `/steer` means, so the controller routes commands and
 * knows nothing about steering: `/steer <n>` promotes an existing queued
 * prompt, `/steer <prompt>` jumps new text to the front, anything else queues
 * normally. `isRemoteCommand` already excludes every `/steer` form, so this
 * runs after the command handler has declined the message.
 */
export async function admitRemoteText(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  dedupKey: string,
  deps: RemotePromptAdmissionDeps,
): Promise<RemoteInboundDisposition> {
  const steer = parseSteerCommand(event.text);
  if (steer.promote !== undefined) return promoteQueuedPrompt(event, steer.promote, deps);
  return admitRemotePrompt(
    event,
    steer.text ?? event.text,
    dedupKey,
    steer.text ? 'steer' : undefined,
    deps,
  );
}

/**
 * `/steer <n>` — run an already-queued prompt next instead of retyping it.
 *
 * The interrupt is what makes this different from reordering: with nothing
 * running there is no turn to cut short and the drain kick alone is enough.
 */
export async function promoteQueuedPrompt(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  position: number,
  deps: RemotePromptAdmissionDeps,
): Promise<RemoteInboundDisposition> {
  const binding = deps.store.binding(event.channel, event.chatId);
  if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
  if (binding.workspaceId !== deps.options.workspaceId) {
    return { kind: 'rejected', reason: 'chat is bound to a different workspace' };
  }
  const queued = deps.store
    .queued(binding.conversationId)
    .filter((item) => item.channel === event.channel && item.chatId === event.chatId);
  if (queued.length === 0) {
    return {
      kind: 'rejected',
      reason: 'nothing is queued to steer to — send /steer <prompt> to run new text next',
    };
  }
  const target = queued[position - 1];
  if (!target) {
    return { kind: 'rejected', reason: `queue has ${queued.length} prompt(s); /queue lists them` };
  }
  if (!(await deps.store.promoteQueued(binding.conversationId, target.id))) {
    return { kind: 'retry', reason: 'queued prompt changed state during promotion' };
  }
  await deps.audit?.record(event, 'steer_queued', target.id).catch(() => undefined);
  const busy = deps.isBusy(binding.conversationId);
  if (busy) {
    deps.host.queueIntent(binding.conversationId);
    await deps.host.interrupt(binding.conversationId).catch((err) => {
      deps.onError?.(
        `Forge remote steering interrupt failed; prompt remains queued: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
  deps.kickDrain(binding.conversationId);
  await deps.channel.send(
    event.chatId,
    `Forge: ${busy ? 'interrupting the turn; running' : 'running'} queued #${position} next — ${
      target.text.length > 120 ? `${target.text.slice(0, 119)}…` : target.text
    }`,
  );
  return { kind: 'handled' };
}

/** Resume the conversation already bound to a chat, loading it through the normal queue. */
export async function resumeRemoteConversation(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  dedupKey: string,
  deps: RemoteResumeDeps,
): Promise<RemoteInboundDisposition> {
  const binding = deps.store.binding(event.channel, event.chatId);
  if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
  if (binding.workspaceId !== deps.options.workspaceId) {
    return { kind: 'rejected', reason: 'chat is bound to a different workspace' };
  }
  if (deps.isBusy(binding.conversationId)) {
    return { kind: 'rejected', reason: 'the bound conversation is already running' };
  }

  // Restore is idempotent for an open conversation and brings a history-only
  // binding back into the sidebar before the normal queue loads its model.
  await deps.restoreConversation(binding.conversationId);
  return admitRemotePrompt(
    event,
    'Continue the current conversation from where you left off. If the task is already complete, report the result.',
    dedupKey,
    undefined,
    deps,
  );
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
