import { z } from 'zod';
import type { InboxMessageOptions } from '../agentBus/agentInbox';
import { AgentRouteHttpError, type AgentRouteFields } from './agentRouteFields';

/** The one contract every bus conversation id has to meet, whether it comes
 *  from `--to` on a message, `origin_conversation`, `send-file` or a read
 *  route's `conversation_id`. The character class is the set `forge.sh` already
 *  checks before it puts an id in a query string, so the shell can never send
 *  an id this server would refuse; a hand-built HTTP request that does gets a
 *  400 naming the field instead of a 404 for a chat that never existed. */
export const ConversationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/u, 'must be 1-128 chars: letters, digits, . _ -');

/** A `--new` chat's name, as short as a tab's and shorter than `deriveTitle`'s
 *  160: it travels in a query string, and the window that opens the chat applies
 *  it before its own title would. One number, so a caller that builds a name can
 *  cut it to exactly what this route will accept. */
export const BUS_CHAT_TITLE_LIMIT = 80;

const TitleSchema = z.string().trim().min(1).max(BUS_CHAT_TITLE_LIMIT);

const AgentMessageOptionsSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    title: TitleSchema.optional(),
    new_chat: z.boolean().optional(),
    conversation_id: ConversationIdSchema.optional(),
    to_running: z.boolean().optional(),
    unattended: z.boolean().optional(),
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
    title: fields['title'],
    new_chat: fields['new_chat'],
    conversation_id: fields['conversation_id'],
    to_running: fields['to_running'],
    unattended: fields['unattended'],
  });
  if (!parsed.success) throw new AgentRouteHttpError(400, zodMessage(parsed.error));
  return {
    ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
    ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
    ...(parsed.data.new_chat !== undefined ? { newChat: parsed.data.new_chat } : {}),
    ...(parsed.data.conversation_id !== undefined
      ? { conversationId: parsed.data.conversation_id }
      : {}),
    ...(parsed.data.to_running !== undefined ? { toRunning: parsed.data.to_running } : {}),
    ...(parsed.data.unattended !== undefined ? { unattended: parsed.data.unattended } : {}),
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

/** A `conversation_id` a read route was handed: absent means "the chat this
 *  session last addressed" and is not an error; present but malformed is a 400
 *  naming the field, so a caller that mistypes an id reads its own answer
 *  instead of a 404 for a chat that never existed. */
export function parseReadConversationId(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const parsed = ConversationIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentRouteHttpError(400, `conversation_id: ${zodMessage(parsed.error)}`);
  }
  return parsed.data;
}
