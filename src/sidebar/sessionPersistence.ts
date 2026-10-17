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
import type { CompactionState } from './compactionTypes';
import { rebuildIndex, type AgentLinkConflict } from '../agentLinks/chatAgentLinks';
import type { HistoryArchive } from './HistoryArchive';
import { openConversationsPersistenceFor, persistMemento } from './openConversationsPersistence';
import {
  ACTIVE_ID_KEY,
  HISTORY_KEY_LEGACY,
  MAX_HISTORY_CONVERSATIONS,
  SESSION_KEY_V1,
  chatMessagesFromSlim,
  UNTITLED_TITLE,
  deriveTitle,
  newConversationId,
  slimPersistMessages,
  type ConversationPersisted,
  type ConversationRuntime,
  type SidebarRuntime,
  type SidebarSessionPersisted,
} from './sessionTypes';

function emptyConversation(id: string, now: number): ConversationRuntime {
  return {
    id,
    title: UNTITLED_TITLE,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function copyCompaction(compaction: {
  summary: string;
  fromIndex: number;
  generation?: number | undefined;
  dividers?:
    | Array<{
        generation: number;
        fromIndex: number;
        source?: 'auto' | 'manual' | undefined;
      }>
    | undefined;
  userMessages?: string[] | undefined;
  recordedActions?:
    | Array<{
        kind: 'file' | 'command';
        key: string;
        outcome: 'ok' | 'failed' | 'unknown';
        line: string;
        durableEvidence?: boolean | undefined;
      }>
    | undefined;
  repoState?: string | undefined;
  memoryKeys?: string[] | undefined;
  omittedActions?: { file: number; command: number } | undefined;
  lastReplyFollowedByTools?: boolean | undefined;
}): CompactionState {
  return {
    summary: compaction.summary,
    fromIndex: compaction.fromIndex,
    ...(compaction.generation !== undefined ? { generation: compaction.generation } : {}),
    ...(compaction.dividers
      ? {
          dividers: compaction.dividers.map((divider) => ({
            generation: divider.generation,
            fromIndex: divider.fromIndex,
            ...(divider.source !== undefined ? { source: divider.source } : {}),
          })),
        }
      : {}),
    ...(compaction.userMessages ? { userMessages: [...compaction.userMessages] } : {}),
    ...(compaction.recordedActions
      ? {
          recordedActions: compaction.recordedActions.map((action) => ({
            kind: action.kind,
            key: action.key,
            outcome: action.outcome,
            line: action.line,
            ...(action.durableEvidence !== undefined
              ? { durableEvidence: action.durableEvidence }
              : {}),
          })),
        }
      : {}),
    ...(compaction.repoState !== undefined ? { repoState: compaction.repoState } : {}),
    ...(compaction.memoryKeys ? { memoryKeys: [...compaction.memoryKeys] } : {}),
    ...(compaction.omittedActions
      ? {
          omittedActions: {
            file: compaction.omittedActions.file,
            command: compaction.omittedActions.command,
          },
        }
      : {}),
    ...(compaction.lastReplyFollowedByTools !== undefined
      ? { lastReplyFollowedByTools: compaction.lastReplyFollowedByTools }
      : {}),
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

export function persistedToRuntime(p: ConversationPersisted): ConversationRuntime {
  return {
    id: p.id,
    title: p.title,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    messages: repairInterruptedToolCalls(chatMessagesFromSlim(p.messages)),
    ...(p.agentLinks !== undefined ? { agentLinks: { ...p.agentLinks } } : {}),
    ...(p.active_model !== undefined ? { active_model: p.active_model } : {}),
    ...(p.cli_sessions !== undefined ? { cli_sessions: { ...p.cli_sessions } } : {}),
    ...(p.compaction !== undefined ? { compaction: copyCompaction(p.compaction) } : {}),
    ...(p.plan !== undefined
      ? { plan: { ...p.plan, items: p.plan.items.map((i) => ({ ...i })) } }
      : {}),
    ...(p.display_diffs !== undefined
      ? { displayDiffs: p.display_diffs.map((diff) => ({ ...diff })) }
      : {}),
    ...(p.active_time_ms !== undefined ? { active_time_ms: p.active_time_ms } : {}),
    ...(p.active_started_at !== undefined ? { active_started_at: p.active_started_at } : {}),
    ...(p.input_tokens !== undefined ? { input_tokens: p.input_tokens } : {}),
    ...(p.output_tokens !== undefined ? { output_tokens: p.output_tokens } : {}),
    ...(p.last_input_tokens !== undefined ? { last_input_tokens: p.last_input_tokens } : {}),
    ...(p.last_output_tokens !== undefined ? { last_output_tokens: p.last_output_tokens } : {}),
    ...(p.model_request_count !== undefined ? { model_request_count: p.model_request_count } : {}),
    ...(p.tool_call_count !== undefined ? { tool_call_count: p.tool_call_count } : {}),
  };
}

/**
 * Result synthesized for a tool call that was still running when Forge was
 * reloaded.
 *
 * Exported because `compactionLedger.ts` must classify it as an UNKNOWN
 * outcome: it is not a failure (it carries no `Error:`/`User declined:`
 * prefix), so a classifier that only checks `isFailureResult` would record the
 * interrupted call as a completed one, in a block that vouches for being
 * host-recorded truth.
 */
export const TOOL_INTERRUPTED_RESULT =
  'Forge was reloaded while this tool call was running. Its result is unknown; inspect the workspace before deciding whether to rerun it.';

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
        content: TOOL_INTERRUPTED_RESULT,
        tool_call_id: call.id,
        name: call.function.name,
      });
    }
  }
  return repaired;
}

function conversationToPersisted(c: ConversationRuntime): ConversationPersisted {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messages: slimPersistMessages(c.messages),
    ...(c.agentLinks !== undefined ? { agentLinks: { ...c.agentLinks } } : {}),
    ...(c.active_model !== undefined ? { active_model: c.active_model } : {}),
    ...(c.cli_sessions !== undefined ? { cli_sessions: { ...c.cli_sessions } } : {}),
    ...(c.compaction !== undefined ? { compaction: copyCompaction(c.compaction) } : {}),
    ...(c.plan !== undefined
      ? { plan: { ...c.plan, items: c.plan.items.map((i) => ({ ...i })) } }
      : {}),
    ...(c.displayDiffs !== undefined
      ? { display_diffs: c.displayDiffs.map((diff) => ({ ...diff })) }
      : {}),
    ...(c.active_time_ms !== undefined ? { active_time_ms: c.active_time_ms } : {}),
    ...(c.active_started_at !== undefined ? { active_started_at: c.active_started_at } : {}),
    ...(c.input_tokens !== undefined ? { input_tokens: c.input_tokens } : {}),
    ...(c.output_tokens !== undefined ? { output_tokens: c.output_tokens } : {}),
    ...(c.last_input_tokens !== undefined ? { last_input_tokens: c.last_input_tokens } : {}),
    ...(c.last_output_tokens !== undefined ? { last_output_tokens: c.last_output_tokens } : {}),
    ...(c.model_request_count !== undefined ? { model_request_count: c.model_request_count } : {}),
    ...(c.tool_call_count !== undefined ? { tool_call_count: c.tool_call_count } : {}),
  };
}

export function runtimeToPersisted(
  session: SidebarRuntime,
  options: { withHistory: boolean } = { withHistory: true },
): SidebarSessionPersisted {
  return {
    activeConversationId: session.activeConversationId,
    conversations: session.conversations.map(conversationToPersisted),
    ...(options.withHistory ? { history: session.history.map(conversationToPersisted) } : {}),
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
  session.history = merged.sort((a, b) => b.updatedAt - a.updatedAt);
}

function migrateLegacyHistory(
  legacy: Array<{ role: 'user' | 'assistant'; content: string }>,
): SidebarRuntime {
  const id = newConversationId();
  const now = Date.now();
  const firstUser = legacy.find((m) => m.role === 'user');
  const title = firstUser ? deriveTitle(firstUser.content.split('\n')[0] ?? '') : UNTITLED_TITLE;
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
 * Load v2 open chats, merging a v1 session when needed; then fall back to the
 * legacy single-history key or a default session. History can still be inline
 * in v1/v2 while its directory migration or a failed write is being recovered.
 * After successful migration from legacy, removes legacy key.
 */
export function loadSidebarSession(
  workspaceState: Memento,
  archive?: HistoryArchive,
  notifyWarning?: (message: string) => void,
): SidebarRuntime {
  const openPersistence = openConversationsPersistenceFor(
    workspaceState,
    archive?.openConversations,
  );
  const loaded = openPersistence.load(workspaceState);
  const d = loaded.v1;
  if (loaded.hasSession) {
    const conversations = loaded.conversations.map(persistedToRuntime);
    if (conversations.length === 0) conversations.push(...createDefaultSession().conversations);
    // The pointer key wins when it still names an open conversation: a tab
    // switch writes only that, so the blob's own `activeConversationId` can be
    // several switches stale. Absent (records written before the split) or
    // dangling, fall back to the blob and then to the first tab.
    const pointer = workspaceState.get<string>(ACTIVE_ID_KEY);
    const candidates = [pointer, loaded.activeConversationId, d?.activeConversationId];
    let activeId = conversations[0]!.id;
    for (const candidate of candidates) {
      if (candidate && conversations.some((conversation) => conversation.id === candidate)) {
        activeId = candidate;
        break;
      }
    }

    persistMemento(workspaceState, HISTORY_KEY_LEGACY, undefined);
    archive?.overflow.list([
      ...conversations.map((conversation) => conversation.id),
      ...(d?.history ?? []).map((conversation) => conversation.id),
      ...loaded.inlineHistory.map((conversation) => conversation.id),
    ]);
    const history = mergeHistory(loadHistory(d, archive), loaded.inlineHistory)
      .filter((entry) => !conversations.some((open) => open.id === entry.id))
      .map(persistedToRuntime);
    return indexSession(
      {
        activeConversationId: activeId,
        conversations,
        // A close can persist the archive file before the open-session memento.
        // If the host crashes between those writes, the open copy is authoritative
        // and the duplicate archive entry must not be shown or restored twice.
        history,
      },
      archive,
      notifyWarning,
    );
  }

  const legacy =
    workspaceState.get<Array<{ role: 'user' | 'assistant'; content: string }>>(HISTORY_KEY_LEGACY);
  if (legacy?.length) {
    const migrated = migrateLegacyHistory(legacy);
    // Preserve the legacy record until a later successful cleanup. Clearing it
    // here could erase the only durable copy when the replacement hits quota.
    persistMemento(workspaceState, SESSION_KEY_V1, runtimeToPersisted(migrated));
    archive?.overflow.list(migrated.conversations.map((conversation) => conversation.id));
    return indexSession(migrated, archive, notifyWarning);
  }

  const session = createDefaultSession();
  session.history = (archive?.load() ?? []).map(persistedToRuntime);
  archive?.overflow.list([
    ...session.conversations.map((conversation) => conversation.id),
    ...session.history.map((conversation) => conversation.id),
  ]);
  return indexSession(session, archive, notifyWarning);
}

function indexSession(
  session: SidebarRuntime,
  archive?: HistoryArchive,
  notifyWarning?: (message: string) => void,
): SidebarRuntime {
  const conflicts = rebuildIndex(agentLinkRecords(session, archive));
  for (const conflict of conflicts) notifyWarning?.(conflictWarning(conflict));
  return session;
}

function conflictWarning(conflict: AgentLinkConflict): string {
  return `Forge: agent session ${conflict.sessionId} is linked to chats "${conflict.firstChat}" and "${conflict.secondChat}"; keeping it with "${conflict.keptChat}" (newest last used).`;
}

function agentLinkRecords(
  session: SidebarRuntime,
  archive?: HistoryArchive,
): Array<{ id: string; title?: string; agentLinks?: ConversationRuntime['agentLinks'] }> {
  const records = [...session.conversations, ...session.history];
  for (const row of archive?.overflow.list(records.map((item) => item.id)) ?? []) {
    if (row.agentLinks)
      records.push({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        messages: [],
        agentLinks: row.agentLinks,
      });
  }
  return records;
}

/**
 * A non-empty memento `history` wins: only a pre-file build, a downgrade, or a
 * save whose file write failed puts one there, and each is newer than the
 * file. An EMPTY one does not — a session whose file was unreadable saves `[]`
 * there, and letting that win would erase the file's archive on the next
 * start. The next save moves a winning memento copy into the file.
 */
function loadHistory(
  persisted: SidebarSessionPersisted | undefined,
  archive: HistoryArchive | undefined,
): ConversationPersisted[] {
  if (!archive) return persisted?.history ?? [];
  if ((persisted?.history?.length ?? 0) > 0) {
    archive.load();
    return persisted?.history ?? [];
  }
  return archive.load() ?? persisted?.history ?? [];
}

function mergeHistory(
  primary: readonly ConversationPersisted[],
  inline: readonly ConversationPersisted[],
): ConversationPersisted[] {
  const byId = new Map(primary.map((conversation) => [conversation.id, conversation]));
  for (const conversation of inline) {
    const current = byId.get(conversation.id);
    if (!current || conversation.updatedAt > current.updatedAt)
      byId.set(conversation.id, conversation);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * With an `archive`, history goes to its file and v2 carries only failed body
 * fallbacks. Without storage, v2 keeps both open and history bodies inline.
 */
export function saveSidebarSession(
  workspaceState: Memento,
  session: SidebarRuntime,
  archive?: HistoryArchive,
  changedId?: string,
): void {
  session.history.sort((a, b) => b.updatedAt - a.updatedAt);
  // Past the cap, chats are evicted to the archive, not dropped. Without a
  // folder (no archive) they are dropped, as they always were.
  for (const conversation of session.history.slice(MAX_HISTORY_CONVERSATIONS)) {
    archive?.overflow.put(conversationToPersisted(conversation));
  }
  session.history = session.history.slice(0, MAX_HISTORY_CONVERSATIONS);
  const inFile = archive?.save(session.history, conversationToPersisted);
  const historyFallback = inFile === true ? [] : session.history.map(conversationToPersisted);
  openConversationsPersistenceFor(workspaceState, archive?.openConversations).save(
    workspaceState,
    session,
    conversationToPersisted,
    historyFallback,
    changedId,
    archive ? () => archive.pruneRemoved() : undefined,
  );
  // Keep the pointer in step so it is always the authoritative answer on load,
  // rather than a value that may be older than the blob beside it.
  persistMemento(workspaceState, ACTIVE_ID_KEY, session.activeConversationId);
}

/**
 * Persist WHICH conversation is active, without touching the transcripts.
 *
 * Switching tabs changes exactly this one string. Routing it through
 * `saveSidebarSession` rebuilt and reserialized every open tab and all 40
 * archived conversations - 16 MB in the workspace this was measured in -
 * synchronously on the extension host, which is a large part of why a switch
 * cost a visible second. See `docs/plans/SIDEBAR_SWITCH_LATENCY_PLAN.md`.
 */
export function saveActiveConversationId(workspaceState: Memento, id: string): void {
  persistMemento(workspaceState, ACTIVE_ID_KEY, id);
}

/** Tab list + transcripts for authoritative webview sync. */
