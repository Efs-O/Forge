/**
 * Reading and writing the multi-conversation session in workspace state.
 *
 * Split out of `sessionTypes`, which keeps the shapes and the pure derivations.
 * Everything here touches the Memento or migrates an older record — including
 * the legacy single-history migration that must keep working for anyone who
 * skipped a version.
 */

import type { Memento } from 'vscode';
import type { ChatMessage } from '../llm/types';
import {
  HISTORY_KEY_LEGACY,
  MAX_HISTORY_CONVERSATIONS,
  SESSION_KEY_V1,
  chatMessagesFromSlim,
  deriveTitle,
  newConversationId,
  sidebarSessionPersistedSchema,
  slimPersistMessages,
  type ConversationPersisted,
  type ConversationRuntime,
  type SidebarRuntime,
  type SidebarSessionPersisted,
} from './sessionTypes';

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

function persistedToRuntime(p: ConversationPersisted): ConversationRuntime {
  return {
    id: p.id,
    title: p.title,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    messages: repairInterruptedToolCalls(chatMessagesFromSlim(p.messages)),
    ...(p.active_model !== undefined ? { active_model: p.active_model } : {}),
    ...(p.cli_sessions !== undefined ? { cli_sessions: { ...p.cli_sessions } } : {}),
    ...(p.compaction !== undefined ? { compaction: { ...p.compaction } } : {}),
    ...(p.display_diffs !== undefined
      ? { displayDiffs: p.display_diffs.map((diff) => ({ ...diff })) }
      : {}),
  };
}

/**
 * A reload can occur after the assistant has announced tool calls but before
 * the host has appended every result. Close those calls with an explicit
 * unknown outcome so strict chat templates remain valid and the next turn does
 * not pretend the tool completed.
 */
function repairInterruptedToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const answered = new Set(
    messages
      .filter((m) => m.role === 'tool' && typeof m.tool_call_id === 'string')
      .map((m) => m.tool_call_id!),
  );
  const repaired: ChatMessage[] = [];
  for (const message of messages) {
    repaired.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      if (answered.has(call.id)) continue;
      repaired.push({
        role: 'tool',
        content:
          'Forge was reloaded while this tool call was running. Its result is unknown; inspect the workspace before deciding whether to rerun it.',
        tool_call_id: call.id,
        name: call.function.name,
      });
    }
  }
  return repaired;
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
      ...(c.compaction !== undefined ? { compaction: { ...c.compaction } } : {}),
      ...(c.displayDiffs !== undefined
        ? { display_diffs: c.displayDiffs.map((diff) => ({ ...diff })) }
        : {}),
    })),
    history: session.history.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: slimPersistMessages(c.messages),
      ...(c.active_model !== undefined ? { active_model: c.active_model } : {}),
      ...(c.cli_sessions !== undefined ? { cli_sessions: { ...c.cli_sessions } } : {}),
      ...(c.compaction !== undefined ? { compaction: { ...c.compaction } } : {}),
      ...(c.displayDiffs !== undefined
        ? { display_diffs: c.displayDiffs.map((diff) => ({ ...diff })) }
        : {}),
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
