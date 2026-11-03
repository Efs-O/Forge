/**
 * The slim persisted message form: what a conversation's transcript looks like
 * on disk, with tool-call turns and tool results kept, plus the conversions
 * from and to `ChatMessage`. The display form (`DisplayPersistMessage`, text
 * only) stays in `sessionTypes.ts`; the two views are deliberately separate.
 */

import { z } from 'zod';
import type { ChatMessage } from '../llm/types';
import { agentSenderMetadataSchema } from '../agentLinks/chatAgentLinks';
import { stripImageParts } from './imageParts';

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

function textContent(content: ChatMessage['content']): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return text || null;
}

/**
 * A tool-calling assistant turn carries `content: null` + `tool_calls`, and its
 * results come back as `role: 'tool'`; filtering those out dropped every trace
 * of tool activity at write time.
 *
 * Backward compatible: every field added here is optional and `content` only
 * widened, so records written by earlier versions still parse unchanged.
 */
/** Metadata only — the bytes live under the ChatAttachmentStore root. */
const attachmentRefSchema = z.object({
  name: z.string(),
  mediaType: z.string(),
  bytes: z.number(),
  relativePath: z.string(),
});

export const slimMsgSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string().nullable(),
  createdAt: z.number().optional(),
  reasoning: z.string().optional(),
  /** Measured spans. Optional, so records written before 0.15.12 still parse. */
  reasoningMs: z.number().optional(),
  toolMs: z.number().optional(),
  stampedAt: z.number().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  internal: z.boolean().optional(),
  midTurn: z.boolean().optional(),
  agentSender: agentSenderMetadataSchema.optional(),
  attachments: z.array(attachmentRefSchema).optional(),
  turnContext: z.string().optional(),
});
export type SlimPersistMessage = z.infer<typeof slimMsgSchema>;

/**
 * Persistence view: keeps tool-call turns and tool results so a reloaded
 * conversation still knows what the agent actually did.
 *
 * `system` is still dropped (rebuilt per request). Array `content` is reduced to
 * its text parts — base64 image data must never land in workspaceState — but the
 * message itself survives now: keying off `role === 'tool'` meant a user prompt
 * sent WITH an attachment had array content, failed the `typeof === 'string'`
 * test, and was dropped whole, losing what the user actually asked. Dropping the
 * pixels silently is its own hazard, so a restored turn carries a note saying the
 * image is gone rather than an intact-looking success line.
 */
export function slimPersistMessages(messages: ChatMessage[]): SlimPersistMessage[] {
  const out: SlimPersistMessage[] = [];
  // One implementation of image-part replacement, shared with the model-facing
  // strip in ModelTurn. The reason picks the note, and `persist` is the only one
  // that may claim the pixels are actually gone.
  for (const m of stripImageParts(messages, { reason: 'persist' })) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;
    const persistedText = typeof m.content === 'string' ? m.content : textContent(m.content);
    const hasText = typeof persistedText === 'string';
    const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    const hasReasoning =
      m.role === 'assistant' && typeof m.reasoning === 'string' && m.reasoning.length > 0;
    // An assistant turn with tool_calls legitimately has content: null.
    // A reasoning-only turn may also have content: null, and must survive reload.
    if (!hasText && !hasToolCalls && !hasReasoning) continue;
    out.push({
      role: m.role,
      content: hasText ? (persistedText as string) : null,
      ...(typeof m.createdAt === 'number' ? { createdAt: m.createdAt } : {}),
      ...(typeof m.reasoning === 'string' && m.reasoning.length > 0
        ? { reasoning: m.reasoning }
        : {}),
      ...(typeof m.reasoningMs === 'number' ? { reasoningMs: m.reasoningMs } : {}),
      ...(typeof m.toolMs === 'number' ? { toolMs: m.toolMs } : {}),
      ...(typeof m.stampedAt === 'number' ? { stampedAt: m.stampedAt } : {}),
      ...(typeof m.turnContext === 'string' ? { turnContext: m.turnContext } : {}),
      ...(hasToolCalls ? { tool_calls: m.tool_calls } : {}),
      ...(typeof m.tool_call_id === 'string' ? { tool_call_id: m.tool_call_id } : {}),
      ...(typeof m.name === 'string' ? { name: m.name } : {}),
      ...(m.internal ? { internal: true } : {}),
      ...(m.midTurn ? { midTurn: true } : {}),
      ...(m.agentSender ? { agentSender: m.agentSender } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    });
  }
  return out;
}

export function chatMessagesFromSlim(slim: SlimPersistMessage[]): ChatMessage[] {
  return slim.map((m) => ({
    role: m.role,
    content: m.content,
    ...(typeof m.createdAt === 'number' ? { createdAt: m.createdAt } : {}),
    ...(typeof m.reasoning === 'string' && m.reasoning.length > 0
      ? { reasoning: m.reasoning }
      : {}),
    ...(typeof m.reasoningMs === 'number' ? { reasoningMs: m.reasoningMs } : {}),
    ...(typeof m.toolMs === 'number' ? { toolMs: m.toolMs } : {}),
    // BL-029: this field was written and never read back, so every tool result
    // from before a reload lost its `[tool result produced at …]` line — the
    // clock `toolResultClock.ts` exists to give the model.
    ...(typeof m.stampedAt === 'number' ? { stampedAt: m.stampedAt } : {}),
    ...(typeof m.turnContext === 'string' ? { turnContext: m.turnContext } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(typeof m.tool_call_id === 'string' ? { tool_call_id: m.tool_call_id } : {}),
    ...(typeof m.name === 'string' ? { name: m.name } : {}),
    ...(m.internal ? { internal: true } : {}),
    ...(m.midTurn ? { midTurn: true } : {}),
    ...(m.agentSender ? { agentSender: m.agentSender } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
  }));
}
