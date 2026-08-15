/**
 * Sidebar multi-conversation session: types, Zod persistence, migration from legacy history.
 */

import type { Memento } from 'vscode';
import { z } from 'zod';
import type { ChatMessage } from '../llm/types';
import type { SessionHistoryMeta, SessionTabMeta } from './messageBridge';

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
type SlimPersistMessage = z.infer<typeof slimMsgSchema>;

/** Subset the webview renders: plain text turns only. */
type DisplayPersistMessage = { role: 'user' | 'assistant'; content: string; reasoning?: string };

const conversationPersistedSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(slimMsgSchema),
  active_model: z.string().optional(),
  cli_sessions: z.record(z.string(), z.string().min(1)).optional(),
});

export const sidebarSessionPersistedSchema = z.object({
  activeConversationId: z.string().min(1),
  conversations: z.array(conversationPersistedSchema),
  history: z.array(conversationPersistedSchema).optional(),
});

export type SidebarSessionPersisted = z.infer<typeof sidebarSessionPersistedSchema>;

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
 * Webview view: renderable turns. Tool *results* stay out — raw tool JSON in the
 * transcript is noise, and the sidebar surfaces tool activity live through its
 * own events.
 *
 * An assistant turn that only called a tool is kept when it carries reasoning.
 * Dropping those made every thinking bubble except the final round's vanish the
 * moment a turn ended and SESSION_SYNC rebuilt the transcript.
 */
export function displayPersistMessages(messages: ChatMessage[]): DisplayPersistMessage[] {
  return messages
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        (typeof m.content === 'string' ||
          (m.role === 'assistant' && typeof m.reasoning === 'string' && m.reasoning.length > 0)),
    )
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      // A reasoning-only turn has content: null; the webview contract is string.
      content: typeof m.content === 'string' ? m.content : '',
      ...(typeof m.reasoning === 'string' && m.reasoning.length > 0
        ? { reasoning: m.reasoning }
        : {}),
    }));
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

function emptyConversation(id: string, now: number): ConversationRuntime {
  return {
    id,
    title: 'Chat',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function createDefaultSession(): SidebarRuntime {
  const id = newConversationId();
  const now = Date.now();
  return {
    activeConversationId: id,
    conversations: [emptyConversation(id, now)],
    history: [],
  };
}

type ConversationPersisted = z.infer<typeof conversationPersistedSchema>;

function persistedToRuntime(p: ConversationPersisted): ConversationRuntime {
  return {
    id: p.id,
    title: p.title,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    messages: chatMessagesFromSlim(p.messages),
    ...(p.active_model !== undefined ? { active_model: p.active_model } : {}),
    ...(p.cli_sessions !== undefined ? { cli_sessions: { ...p.cli_sessions } } : {}),
  };
}

export function runtimeToPersisted(session: SidebarRuntime): SidebarSessionPersisted {
  return {
    activeConversationId: session.activeConversationId,
    conversations: session.conversations.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: slimPersistMessages(c.messages),
      ...(c.active_model !== undefined ? { active_model: c.active_model } : {}),
      ...(c.cli_sessions !== undefined ? { cli_sessions: { ...c.cli_sessions } } : {}),
    })),
    history: session.history.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: slimPersistMessages(c.messages),
      ...(c.active_model !== undefined ? { active_model: c.active_model } : {}),
      ...(c.cli_sessions !== undefined ? { cli_sessions: { ...c.cli_sessions } } : {}),
    })),
  };
}

function dedupeConversations(conversations: ConversationRuntime[]): ConversationRuntime[] {
  const seen = new Set<string>();
  const out: ConversationRuntime[] = [];
  for (const conversation of conversations) {
    if (seen.has(conversation.id)) continue;
    seen.add(conversation.id);
    out.push(conversation);
  }
  return out;
}

export function upsertHistoryConversation(
  session: SidebarRuntime,
  conversation: ConversationRuntime,
): void {
  const archived: ConversationRuntime = {
    ...conversation,
    messages: [...conversation.messages],
    updatedAt: Date.now(),
  };
  const merged = dedupeConversations([
    archived,
    ...session.history.filter((item) => item.id !== archived.id),
  ]);
  session.history = merged
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_HISTORY_CONVERSATIONS);
}

function migrateLegacyHistory(
  legacy: Array<{ role: 'user' | 'assistant'; content: string }>,
): SidebarRuntime {
  const id = newConversationId();
  const now = Date.now();
  const firstUser = legacy.find((m) => m.role === 'user');
  const title = firstUser ? deriveTitle(firstUser.content.split('\n')[0] ?? '') : 'Chat';
  return {
    activeConversationId: id,
    conversations: [
      {
        id,
        title,
        createdAt: now,
        updatedAt: now,
        messages: chatMessagesFromSlim(legacy),
      },
    ],
    history: [],
  };
}

/**
 * Load session from workspace state: v1 blob, else legacy single history, else default.
 * After successful migration from legacy, removes legacy key.
 */
export function loadSidebarSession(workspaceState: Memento): SidebarRuntime {
  const rawV1 = workspaceState.get<unknown>(SESSION_KEY_V1);
  const parsedV1 = sidebarSessionPersistedSchema.safeParse(rawV1);
  if (parsedV1.success && parsedV1.data.conversations.length > 0) {
    const d = parsedV1.data;
    const activeOk = d.conversations.some((c) => c.id === d.activeConversationId);
    let activeId = d.activeConversationId;
    if (!activeOk) activeId = d.conversations[0].id;

    void workspaceState.update(HISTORY_KEY_LEGACY, undefined as unknown as string);
    return {
      activeConversationId: activeId,
      conversations: d.conversations.map(persistedToRuntime),
      history: (d.history ?? []).map(persistedToRuntime),
    };
  }

  const legacy =
    workspaceState.get<Array<{ role: 'user' | 'assistant'; content: string }>>(HISTORY_KEY_LEGACY);
  if (legacy?.length) {
    const migrated = migrateLegacyHistory(legacy);
    void workspaceState.update(HISTORY_KEY_LEGACY, undefined as unknown as string);
    void workspaceState.update(SESSION_KEY_V1, runtimeToPersisted(migrated));
    return migrated;
  }

  return createDefaultSession();
}

export function saveSidebarSession(workspaceState: Memento, session: SidebarRuntime): void {
  void workspaceState.update(SESSION_KEY_V1, runtimeToPersisted(session));
}

/** Tab list + transcripts for authoritative webview sync. */
export function tabMetasFromSession(
  session: SidebarRuntime,
  streamingIds?: ReadonlySet<string>,
): SessionTabMeta[] {
  return session.conversations.map((c) => {
    // Display count: tool turns are persisted but must not inflate the badge.
    const shown = displayPersistMessages(c.messages);
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
      const shown = displayPersistMessages(c.messages);
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
    out[c.id] = displayPersistMessages(c.messages);
  }
  for (const c of session.history) {
    out[c.id] = displayPersistMessages(c.messages);
  }
  return out;
}
