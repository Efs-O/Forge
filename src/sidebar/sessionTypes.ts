/**
 * Sidebar multi-conversation session: types, Zod persistence, migration from legacy history.
 */

import { z } from 'zod';
export {
  createDefaultSession,
  loadSidebarSession,
  runtimeToPersisted,
  saveSidebarSession,
  upsertHistoryConversation,
} from './sessionPersistence';
import type { ChatMessage } from '../llm/types';
import type { DiffHunk, SessionHistoryMeta, SessionTabMeta } from './messageBridge';
import { capDisplayText } from '../tools/resultCap';
import { isFailureResult, resultLabel } from './toolResultView';

export type { SessionHistoryMeta, SessionTabMeta };

/** Max open tabs — bounds workspaceState size and UI. */
export const MAX_CONVERSATIONS = 12;
export const MAX_HISTORY_CONVERSATIONS = 40;

export const HISTORY_KEY_LEGACY = 'forge.conversation.history';

export const SESSION_KEY_V1 = 'forge.conversations.v1';

const TITLE_MAX_LEN = 48;

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

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
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});
export type SlimPersistMessage = z.infer<typeof slimMsgSchema>;

/** Subset of the transcript which can be safely restored into the webview. */
export type DisplayPersistMessage =
  | { role: 'user' | 'assistant'; content: string; reasoning?: string }
  | {
      role: 'tool';
      content: string;
      toolName: string;
      toolResult: string;
      toolResultTotal: number;
      toolIsError?: boolean;
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
    .object({ summary: z.string().min(1), fromIndex: z.number().int().min(0) })
    .optional(),
  // Optional migration field: previews written by older Forge versions were
  // only live webview state and therefore were not recoverable after a sync.
  display_diffs: z.array(displayDiffSchema).optional(),
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
  compaction?: { summary: string; fromIndex: number };
  /** Durable presentation previews, deliberately separate from LLM messages. */
  displayDiffs?: ConversationDisplayDiff[];
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

export function deriveTitle(firstUserLine: string): string {
  const line = firstUserLine.replace(/\s+/g, ' ').trim();
  if (!line) return 'Chat';
  return line.length > TITLE_MAX_LEN ? `${line.slice(0, TITLE_MAX_LEN)}…` : line;
}

/**
 * Persistence view: keeps tool-call turns and tool results so a reloaded
 * conversation still knows what the agent actually did.
 *
 * `system` is still dropped (rebuilt per request), and so is array `content`
 * (image parts) — that was never persisted and widening it is a separate change.
 */
export function slimPersistMessages(messages: ChatMessage[]): SlimPersistMessage[] {
  const out: SlimPersistMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;
    const hasText = typeof m.content === 'string';
    const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    // An assistant turn with tool_calls legitimately has content: null.
    if (!hasText && !hasToolCalls) continue;
    out.push({
      role: m.role,
      content: hasText ? (m.content as string) : null,
      ...(typeof m.reasoning === 'string' && m.reasoning.length > 0
        ? { reasoning: m.reasoning }
        : {}),
      ...(hasToolCalls ? { tool_calls: m.tool_calls } : {}),
      ...(typeof m.tool_call_id === 'string' ? { tool_call_id: m.tool_call_id } : {}),
      ...(typeof m.name === 'string' ? { name: m.name } : {}),
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
    if (m.role === 'tool' && typeof m.content === 'string') {
      const toolName = m.name ?? 'tool';
      const { text: toolResult, totalChars: toolResultTotal } = capDisplayText(m.content);
      out.push({
        role: 'tool',
        content: `${toolName} → ${resultLabel(toolName, m.content, null)}`,
        toolName,
        toolResult,
        toolResultTotal,
        ...(isFailureResult(m.content) ? { toolIsError: true } : {}),
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
    if (m.role === 'assistant' && content && reasoning) {
      out.push({ role: 'assistant', content: '', reasoning });
      out.push({ role: 'assistant', content });
      continue;
    }
    out.push({
      role: m.role,
      // A reasoning-only turn has content: null; the webview contract is string.
      content,
      ...(reasoning ? { reasoning } : {}),
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
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(typeof m.tool_call_id === 'string' ? { tool_call_id: m.tool_call_id } : {}),
    ...(typeof m.name === 'string' ? { name: m.name } : {}),
  }));
}

export function tabMetasFromSession(
  session: SidebarRuntime,
  streamingIds?: ReadonlySet<string>,
): SessionTabMeta[] {
  return session.conversations.map((c) => {
    // Tool turns are restored but must not inflate the user-facing badge.
    const shown = displayPersistMessages(c.messages, c.displayDiffs).filter(
      (m) => m.role !== 'tool',
    );
    return {
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: shown.length,
      ...(c.active_model !== undefined ? { active_model: c.active_model } : {}),
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
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: shown.length,
        ...(c.active_model !== undefined ? { active_model: c.active_model } : {}),
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
