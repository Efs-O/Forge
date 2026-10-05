import { z } from 'zod';
import type { InboxMessageOptions } from '../agentBus/agentInbox';
import { AgentRouteHttpError, type AgentRouteFields } from './agentRouteFields';

const ConversationIdSchema = z.string().trim().min(1).max(128);

const AgentMessageOptionsSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    new_chat: z.boolean().optional(),
    reply_in_chat: z.boolean().optional(),
    conversation_id: ConversationIdSchema.optional(),
    to_running: z.boolean().optional(),
  })
  .refine(
    (options) =>
      !(options.conversation_id && options.to_running) &&
      !(options.new_chat && (options.conversation_id || options.to_running)),
    'choose one Forge chat target; new_chat cannot be combined with a target',
  );

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'message'}: ${issue.message}`)
    .join('; ');
}

/** Parse and normalize Forge-chat targeting fields from /agent/message. */
export function parseAgentMessageOptions(fields: AgentRouteFields): InboxMessageOptions {
  const parsed = AgentMessageOptionsSchema.safeParse({
    model: fields['model'],
    new_chat: fields['new_chat'],
    reply_in_chat: fields['reply_in_chat'],
    conversation_id: fields['conversation_id'],
    to_running: fields['to_running'],
  });
  if (!parsed.success) throw new AgentRouteHttpError(400, zodMessage(parsed.error));
  return {
    ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
    ...(parsed.data.new_chat !== undefined ? { newChat: parsed.data.new_chat } : {}),
    ...(parsed.data.reply_in_chat !== undefined ? { replyInChat: parsed.data.reply_in_chat } : {}),
    ...(parsed.data.conversation_id !== undefined
      ? { conversationId: parsed.data.conversation_id }
      : {}),
    ...(parsed.data.to_running !== undefined ? { toRunning: parsed.data.to_running } : {}),
  };
}

/** Parse the origin chat using the same id contract as conversation_id. */
export function parseOriginConversation(fields: AgentRouteFields): string | undefined {
  const raw = fields['origin_conversation'];
  if (raw === undefined) return undefined;
  const parsed = ConversationIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentRouteHttpError(400, `origin_conversation: ${zodMessage(parsed.error)}`);
  }
  return parsed.data;
}
