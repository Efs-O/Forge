/**
 * Sidebar multi-conversation session: types, Zod persistence, migration from legacy history.
 */

import { z } from 'zod';
import type { CompactionState } from './compactionTypes';
import { compactionPersistedSchema } from './compactionPersistedSchema';
export {
  createDefaultSession,
  loadSidebarSession,
  runtimeToPersisted,
  saveActiveConversationId,
  saveSidebarSession,
  upsertHistoryConversation,
} from './sessionPersistence';
import type { ChatAttachmentRef, ChatMessage } from '../llm/types';
import { stripImageParts } from './imageParts';
import type { DiffHunk, SessionHistoryMeta, SessionTabMeta } from './messageBridge';

export type { SessionHistoryMeta, SessionTabMeta };

// Naming lives in its own module; re-exported here because sessionTypes is
// the import site every caller already reaches for.
export { UNTITLED_TITLE, deriveTitle, displayTitle, isUntitled } from './conversationTitle';

/** Max open tabs — bounds workspaceState size and UI. */
export const MAX_CONVERSATIONS = 12;
export const MAX_HISTORY_CONVERSATIONS = 40;

export const HISTORY_KEY_LEGACY = 'forge.conversation.history';

export const SESSION_KEY_V1 = 'forge.conversations.v1';
/** Latest invalid session blob, retained so a later version can recover it. */
export const SESSION_KEY_V1_CORRUPT = 'forge.conversations.v1.corrupt';

/**
 * Which conversation is active, stored apart from the transcript blob so a tab
 * switch does not have to rewrite it. See `saveActiveConversationId`.
 */
export const ACTIVE_ID_KEY = 'forge.conversations.activeId';

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

const slimMsgSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string().nullable(),
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
  attachments: z.array(attachmentRefSchema).optional(),
});
export type SlimPersistMessage = z.infer<typeof slimMsgSchema>;

/** Subset of the transcript which can be safely restored into the webview. */
export type DisplayPersistMessage =
  | {
      role: 'user' | 'assistant';
      content: string;
      reasoning?: string;
      reasoningMs?: number;
      midTurn?: boolean;
      attachments?: ChatAttachmentRef[];
    }
  | {
      role: 'tool';
      content: string;
      toolName: string;
      toolResult: string;
      toolResultTotal: number;
      toolIsError?: boolean;
      toolMs?: number;
      stampedAt?: number;
    }
  | {
      role: 'diff';
      content: string;
      diffHunks: DiffHunk[] | null;
      diffIsNew: boolean;
      diffIsDeleted: boolean;
    };

/** A file preview produced by one completed native tool call. */
export interface ConversationDisplayDiff {
  toolCallId: string;
  filePath: string;
  hunks: DiffHunk[] | null;
  isNew: boolean;
  isDeleted: boolean;
}

const diffLineSchema = z.object({
  kind: z.enum(['context', 'added', 'removed']),
  text: z.string(),
});
const displayDiffSchema = z.object({
  toolCallId: z.string().min(1),
  filePath: z.string().min(1),
  hunks: z
    .array(
      z.object({
        oldStart: z.number().int(),
        newStart: z.number().int(),
        lines: z.array(diffLineSchema),
      }),
    )
    .nullable(),
  isNew: z.boolean(),
  isDeleted: z.boolean(),
});

/**
 * Bounds on the agent-written task plan.
 *
 * `update_plan` is auto-approved, so a model can write this state with no
 * confirmation gate, and the result is both persisted to session.json AND
 * re-injected into every subsequent request. Unbounded, that is a context leak
 * that compounds each round rather than a one-off mistake.
 */
export const PLAN_MAX_ITEMS = 20;
export const PLAN_ITEM_MAX_CHARS = 200;

// `.strict()`, not the Zod default: an object schema that silently STRIPS
// unknown keys would accept the arbitrary blob the advertised
// `additionalProperties: false` promises to refuse, and the model would never
// learn its call was wrong.
export const planItemSchema = z
  .object({
    text: z.string().min(1).max(PLAN_ITEM_MAX_CHARS),
    status: z.enum(['pending', 'active', 'done']),
  })
  .strict();

export type PlanItem = z.infer<typeof planItemSchema>;
export interface ConversationPlan {
  items: PlanItem[];
  updatedAt: number;
}

export const conversationPersistedSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(slimMsgSchema),
  active_model: z.string().optional(),
  cli_sessions: z.record(z.string(), z.string().min(1)).optional(),
  // Optional, so records written before compaction existed still parse.
  compaction: compactionPersistedSchema.optional(),
  // The bounds are re-asserted here, not just in the tool schema: a hand-edited
  // or corrupted session.json must not be able to reintroduce an unbounded plan
  // on load, since every round re-injects it into the prompt.
  plan: z
    .object({
      items: z.array(planItemSchema).min(1).max(PLAN_MAX_ITEMS),
      updatedAt: z.number().int(),
    })
    .optional(),
  // Optional migration field: previews written by older Forge versions were
  // only live webview state and therefore were not recoverable after a sync.
  display_diffs: z.array(displayDiffSchema).optional(),
  // Active-agent-time tracking. Optional so pre-existing records parse unchanged.
  active_time_ms: z.number().int().min(0).optional(),
  active_started_at: z.number().int().optional(),
  input_tokens: z.number().int().min(0).optional(),
  output_tokens: z.number().int().min(0).optional(),
  last_input_tokens: z.number().int().min(0).optional(),
  last_output_tokens: z.number().int().min(0).optional(),
  model_request_count: z.number().int().min(0).optional(),
  tool_call_count: z.number().int().min(0).optional(),
});

export const sidebarSessionPersistedSchema = z.object({
  activeConversationId: z.string().min(1),
  conversations: z.array(conversationPersistedSchema),
  history: z.array(conversationPersistedSchema).optional(),
});

export type SidebarSessionPersisted = z.infer<typeof sidebarSessionPersistedSchema>;
export type ConversationPersisted = z.infer<typeof conversationPersistedSchema>;

/** In-memory conversation (full transcript including tool/tool_result for agent loop). */
export interface ConversationRuntime {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  active_model?: string;
  /** Persistent external CLI sessions keyed by configured Forge model name. */
  cli_sessions?: Record<string, string>;
  /**
   * Set by /compact. The model is sent `summary` + `messages.slice(fromIndex)`;
   * `messages` itself is never truncated, so the sidebar transcript and the
   * persisted record stay whole. Clearing this restores full context.
   */
  compaction?: CompactionState;
  /**
   * Agent-maintained task ledger, written by the `update_plan` tool.
   *
   * Held as conversation state rather than as transcript text so compaction
   * cannot summarize it away: it is re-rendered into the model-facing messages
   * every round (see ModelTurn's prepareMessages). `updatedAt` is stamped by
   * the host, never by the model — the staleness the render displays would be
   * worthless if the writer could choose it.
   */
  plan?: ConversationPlan;
  /** Durable presentation previews, deliberately separate from LLM messages. */
  displayDiffs?: ConversationDisplayDiff[];
  /**
   * Set once the user has been told this conversation lost images to a reload.
   *
   * Deliberately NOT persisted — `runtimeToPersisted` is an allowlist and this
   * field is not on it. Resetting per session is the point: each reload is a
   * fresh loss worth announcing once, and repeating it every turn would be noise
   * for a condition the user cannot undo.
   */
  imageLossNoticed?: boolean;
  /**
   * Accumulated active-agent time in milliseconds (model work + tool execution,
   * excluding approval waits). Set after each completed generation interval.
   */
  active_time_ms?: number;
  /**
   * Epoch ms when the current active interval began. Present while a turn is
   * in progress; cleared (and folded into `active_time_ms`) when the turn ends.
   */
  active_started_at?: number;
  /** Provider-reported prompt tokens accumulated for this conversation. */
  input_tokens?: number;
  /** Provider-reported completion tokens accumulated for this conversation. */
  output_tokens?: number;
  /** Prompt tokens in the most recent model request. */
  last_input_tokens?: number;
  /** Completion tokens in the most recent model request. */
  last_output_tokens?: number;
  /** Number of model requests that have reported usage. */
  model_request_count?: number;
  /**
   * Tool calls dispatched in this conversation. Counts what was *dispatched*,
   * so a refused or failed call still counts: it spent a round either way, and
   * a figure that only counted successes would understate exactly the turns
   * worth looking at.
   */
  tool_call_count?: number;
}

export interface SidebarRuntime {
  activeConversationId: string;
  conversations: ConversationRuntime[];
  history: ConversationRuntime[];
}

/** A conversation by id, open tabs first, then archived history. */
export function findConversation(
  sidebar: SidebarRuntime,
  id: string,
): ConversationRuntime | undefined {
  return sidebar.conversations.find((c) => c.id === id) ?? sidebar.history.find((c) => c.id === id);
}

export function newConversationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

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
    // An assistant turn with tool_calls legitimately has content: null.
    if (!hasText && !hasToolCalls) continue;
    out.push({
      role: m.role,
      content: hasText ? (persistedText as string) : null,
      ...(typeof m.reasoning === 'string' && m.reasoning.length > 0
        ? { reasoning: m.reasoning }
        : {}),
      ...(typeof m.reasoningMs === 'number' ? { reasoningMs: m.reasoningMs } : {}),
      ...(typeof m.toolMs === 'number' ? { toolMs: m.toolMs } : {}),
      ...(typeof m.stampedAt === 'number' ? { stampedAt: m.stampedAt } : {}),
      ...(typeof m.stampedAt === 'number' ? { stampedAt: m.stampedAt } : {}),
      ...(hasToolCalls ? { tool_calls: m.tool_calls } : {}),
      ...(typeof m.tool_call_id === 'string' ? { tool_call_id: m.tool_call_id } : {}),
      ...(typeof m.name === 'string' ? { name: m.name } : {}),
      ...(m.internal ? { internal: true } : {}),
      ...(m.midTurn ? { midTurn: true } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    });
  }
  return out;
}

export function chatMessagesFromSlim(slim: SlimPersistMessage[]): ChatMessage[] {
  return slim.map((m) => ({
    role: m.role,
    content: m.content,
    ...(typeof m.reasoning === 'string' && m.reasoning.length > 0
      ? { reasoning: m.reasoning }
      : {}),
    ...(typeof m.reasoningMs === 'number' ? { reasoningMs: m.reasoningMs } : {}),
    ...(typeof m.toolMs === 'number' ? { toolMs: m.toolMs } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(typeof m.tool_call_id === 'string' ? { tool_call_id: m.tool_call_id } : {}),
    ...(typeof m.name === 'string' ? { name: m.name } : {}),
    ...(m.internal ? { internal: true } : {}),
    ...(m.midTurn ? { midTurn: true } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
  }));
}
