/**
 * Sidebar multi-conversation session: types, Zod persistence, migration from legacy history.
 */

import { z } from 'zod';
import {
  COMPACTION_REPO_STATE_MAX_CHARS,
  RECORDED_ACTION_KEY_MAX_CHARS,
  RECORDED_ACTION_LINE_MAX_CHARS,
  RECORDED_ACTION_MAX_ITEMS,
  type CompactionState,
} from './compactionTypes';
import { LAST_REPLY_MAX_CHARS } from './compactionLastReply';
import { USER_CONTEXT_MAX_MESSAGES, USER_CONTEXT_MESSAGE_MAX_CHARS } from './compactionUserContext';
export {
  createDefaultSession,
  loadSidebarSession,
  runtimeToPersisted,
  saveSidebarSession,
  upsertHistoryConversation,
} from './sessionPersistence';
import type { ChatMessage } from '../llm/types';
import { stripImageParts } from './imageParts';
import type { DiffHunk, SessionHistoryMeta, SessionTabMeta } from './messageBridge';
import { capDisplayText } from '../tools/resultCap';
import { isFailureResult, resultLabel } from './toolResultView';
import { displayTitle } from './conversationTitle';

export type { SessionHistoryMeta, SessionTabMeta };

// Naming lives in its own module; re-exported here because sessionTypes is
// the import site every caller already reaches for.
export { UNTITLED_TITLE, deriveTitle, displayTitle, isUntitled } from './conversationTitle';

/** Max open tabs — bounds workspaceState size and UI. */
export const MAX_CONVERSATIONS = 12;
export const MAX_HISTORY_CONVERSATIONS = 40;

export const HISTORY_KEY_LEGACY = 'forge.conversation.history';

export const SESSION_KEY_V1 = 'forge.conversations.v1';

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
const slimMsgSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string().nullable(),
  reasoning: z.string().optional(),
  /** Measured spans. Optional, so records written before 0.15.12 still parse. */
  reasoningMs: z.number().optional(),
  toolMs: z.number().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  internal: z.boolean().optional(),
});
export type SlimPersistMessage = z.infer<typeof slimMsgSchema>;

/** Subset of the transcript which can be safely restored into the webview. */
export type DisplayPersistMessage =
  | { role: 'user' | 'assistant'; content: string; reasoning?: string; reasoningMs?: number }
  | {
      role: 'tool';
      content: string;
      toolName: string;
      toolResult: string;
      toolResultTotal: number;
      toolIsError?: boolean;
      toolMs?: number;
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
  compaction: z
    .object({
      summary: z.string().min(1),
      fromIndex: z.number().int().min(0),
      generation: z.number().int().min(1).optional(),
      userMessages: z
        .array(
          z
            .string()
            .min(1)
            .max(USER_CONTEXT_MESSAGE_MAX_CHARS + 40),
        )
        .max(USER_CONTEXT_MAX_MESSAGES)
        .optional(),
      recordedActions: z
        .array(
          z
            .object({
              kind: z.enum(['file', 'command']),
              key: z.string().min(1).max(RECORDED_ACTION_KEY_MAX_CHARS),
              outcome: z.enum(['ok', 'failed', 'unknown']),
              line: z.string().min(1).max(RECORDED_ACTION_LINE_MAX_CHARS),
              durableEvidence: z.boolean().optional(),
            })
            .strict(),
        )
        .max(RECORDED_ACTION_MAX_ITEMS)
        .optional(),
      repoState: z.string().max(COMPACTION_REPO_STATE_MAX_CHARS).optional(),
      // The object is `.strict()`, so a field added to CompactionState without a
      // row here does not degrade — it fails the parse and drops the whole
      // compaction on reload, restoring an uncompacted window.
      lastReply: z
        .string()
        .min(1)
        .max(LAST_REPLY_MAX_CHARS + 20)
        .optional(),
    })
    .strict()
    .optional(),
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
}

export interface SidebarRuntime {
  activeConversationId: string;
  conversations: ConversationRuntime[];
  history: ConversationRuntime[];
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
      ...(hasToolCalls ? { tool_calls: m.tool_calls } : {}),
      ...(typeof m.tool_call_id === 'string' ? { tool_call_id: m.tool_call_id } : {}),
      ...(typeof m.name === 'string' ? { name: m.name } : {}),
      ...(m.internal ? { internal: true } : {}),
    });
  }
  return out;
}

/**
 * Webview view: renderable turns. Completed tool calls are included so reload
 * can reconstruct the work already done. Their body is capped by the same rule
 * as a live ToolResult message, rather than copying an unbounded tool payload
 * into a webview message.
 *
 * An assistant turn that only called a tool is kept when it carries reasoning.
 * Dropping those made every thinking bubble except the final round's vanish the
 * moment a turn ended and SESSION_SYNC rebuilt the transcript.
 */
export function displayPersistMessages(
  messages: ChatMessage[],
  displayDiffs: ConversationDisplayDiff[] = [],
): DisplayPersistMessage[] {
  const out: DisplayPersistMessage[] = [];
  const diffsByToolCall = new Map<string, ConversationDisplayDiff[]>();
  for (const diff of displayDiffs) {
    const current = diffsByToolCall.get(diff.toolCallId);
    if (current) current.push(diff);
    else diffsByToolCall.set(diff.toolCallId, [diff]);
  }
  for (const m of messages) {
    if (m.internal) continue;
    const toolText = m.role === 'tool' ? textContent(m.content) : null;
    if (m.role === 'tool' && toolText !== null) {
      const toolName = m.name ?? 'tool';
      const { text: toolResult, totalChars: toolResultTotal } = capDisplayText(toolText);
      out.push({
        role: 'tool',
        content: `${toolName} → ${resultLabel(toolName, toolText, null)}`,
        toolName,
        toolResult,
        toolResultTotal,
        ...(isFailureResult(toolText) ? { toolIsError: true } : {}),
        ...(typeof m.toolMs === 'number' ? { toolMs: m.toolMs } : {}),
      });
      for (const diff of diffsByToolCall.get(m.tool_call_id ?? '') ?? []) {
        out.push({
          role: 'diff',
          content: diff.filePath,
          diffHunks: diff.hunks,
          diffIsNew: diff.isNew,
          diffIsDeleted: diff.isDeleted,
        });
      }
      continue;
    }
    if (
      (m.role !== 'user' && m.role !== 'assistant') ||
      (typeof m.content !== 'string' &&
        !(m.role === 'assistant' && typeof m.reasoning === 'string' && m.reasoning.length > 0))
    ) {
      continue;
    }
    const content = typeof m.content === 'string' ? m.content : '';
    const reasoning = typeof m.reasoning === 'string' && m.reasoning.length > 0 ? m.reasoning : '';
    // The final answer can follow streamed reasoning in the same model turn.
    // The ordinary message renderer intentionally shows answer text only, so
    // preserve the thought as its own Thinking row rather than losing it when
    // session sync replaces the live stream.
    // The span belongs to the thought, so on a split turn it rides the reasoning
    // half - the answer half never reasoned.
    const reasoningMs = typeof m.reasoningMs === 'number' ? { reasoningMs: m.reasoningMs } : {};
    if (m.role === 'assistant' && content && reasoning) {
      out.push({ role: 'assistant', content: '', reasoning, ...reasoningMs });
      out.push({ role: 'assistant', content });
      continue;
    }
    out.push({
      role: m.role,
      // A reasoning-only turn has content: null; the webview contract is string.
      content,
      ...(reasoning ? { reasoning, ...reasoningMs } : {}),
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
  }));
}

export function tabMetasFromSession(
  session: SidebarRuntime,
  streamingIds?: ReadonlySet<string>,
  getActiveTimeMs?: (conversation: ConversationRuntime) => number,
): SessionTabMeta[] {
  return session.conversations.map((c) => {
    // Tool turns are restored but must not inflate the user-facing badge.
    const shown = displayPersistMessages(c.messages, c.displayDiffs).filter(
      (m) => m.role !== 'tool',
    );
    return {
      id: c.id,
      title: displayTitle(c.title),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: shown.length,
      ...(c.active_model !== undefined ? { active_model: c.active_model } : {}),
      active_time_ms: getActiveTimeMs?.(c) ?? c.active_time_ms ?? 0,
      ...(streamingIds?.has(c.id) ? { streaming: true } : {}),
    };
  });
}

export function historyMetasFromSession(session: SidebarRuntime): SessionHistoryMeta[] {
  const openIds = new Set(session.conversations.map((c) => c.id));
  return session.history
    .filter((c) => !openIds.has(c.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => {
      const shown = displayPersistMessages(c.messages, c.displayDiffs).filter(
        (m) => m.role !== 'tool',
      );
      return {
        id: c.id,
        title: displayTitle(c.title),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: shown.length,
        ...(c.active_model !== undefined ? { active_model: c.active_model } : {}),
        active_time_ms: c.active_time_ms ?? 0,
      };
    });
}

/** Transcripts for webview sync — display view, not the persistence view. */
export function slimMessagesById(session: SidebarRuntime): Record<string, DisplayPersistMessage[]> {
  const out: Record<string, DisplayPersistMessage[]> = {};
  for (const c of session.conversations) {
    out[c.id] = displayPersistMessages(c.messages, c.displayDiffs);
  }
  for (const c of session.history) {
    out[c.id] = displayPersistMessages(c.messages, c.displayDiffs);
  }
  return out;
}
