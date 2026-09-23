/**
 * Reading and writing the multi-conversation session in workspace state.
 *
 * Split out of `sessionTypes`, which keeps the shapes and the pure derivations.
 * Everything here touches the Memento or migrates an older record — including
 * the legacy single-history migration that must keep working for anyone who
 * skipped a version.
 */

import type { Memento } from 'vscode';
import { getLogger } from '../util/logger';
import type { ChatMessage } from '../llm/types';
import type { CompactionState } from './compactionTypes';
import type { HistoryArchive } from './HistoryArchive';
import type { ArchivedSessions } from './ArchivedSessions';
import {
  ACTIVE_ID_KEY,
  HISTORY_KEY_LEGACY,
  MAX_HISTORY_CONVERSATIONS,
  SESSION_KEY_V1,
  SESSION_KEY_V1_CORRUPT,
  chatMessagesFromSlim,
  UNTITLED_TITLE,
  deriveTitle,
  newConversationId,
  sidebarSessionPersistedSchema,
  slimPersistMessages,
  type ConversationPersisted,
  type ConversationRuntime,
  type SidebarRuntime,
  type SidebarSessionPersisted,
} from './sessionTypes';

const log = getLogger();
const pendingMementoWrites = new WeakMap<Memento, Promise<void>>();

/** Serialize writes so a rejected quota write is visible and cannot race a later update. */
function persistMemento(workspaceState: Memento, key: string, value: unknown): void {
  const previous = pendingMementoWrites.get(workspaceState) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => workspaceState.update(key, value));
  pendingMementoWrites.set(workspaceState, pending);
  void pending.catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    log.error(`[sessionPersistence] failed to persist ${key}: ${detail}`);
  });
}

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
 * Load session from workspace state: v1 blob, else legacy single history, else default.
 * Archived history comes from `archive` unless the blob still carries its own.
 * After successful migration from legacy, removes legacy key.
 */
export function loadSidebarSession(
  workspaceState: Memento,
  archive?: HistoryArchive,
): SidebarRuntime {
  const rawV1 = workspaceState.get<unknown>(SESSION_KEY_V1);
  const parsedV1 = sidebarSessionPersistedSchema.safeParse(rawV1);
  if (parsedV1.success && parsedV1.data.conversations.length > 0) {
    const d = parsedV1.data;
    // The pointer key wins when it still names an open conversation: a tab
    // switch writes only that, so the blob's own `activeConversationId` can be
    // several switches stale. Absent (records written before the split) or
    // dangling, fall back to the blob and then to the first tab.
    const pointer = workspaceState.get<string>(ACTIVE_ID_KEY);
    const candidates = [pointer, d.activeConversationId];
    let activeId = d.conversations[0].id;
    for (const candidate of candidates) {
      if (candidate && d.conversations.some((c) => c.id === candidate)) {
        activeId = candidate;
        break;
      }
    }

    persistMemento(workspaceState, HISTORY_KEY_LEGACY, undefined);
    archive?.overflow.list([
      ...d.conversations.map((conversation) => conversation.id),
      ...(d.history ?? []).map((conversation) => conversation.id),
    ]);
    return {
      activeConversationId: activeId,
      conversations: d.conversations.map(persistedToRuntime),
      // A close can persist the archive file before the open-session memento.
      // If the host crashes between those writes, the open copy is authoritative
      // and the duplicate archive entry must not be shown or restored twice.
      history: loadHistory(d, archive)
        .filter((entry) => !d.conversations.some((open) => open.id === entry.id))
        .map(persistedToRuntime),
    };
  }

  if (rawV1 !== undefined && !parsedV1.success) {
    const detail = parsedV1.error.message;
    log.error(
      `[sessionPersistence] invalid ${SESSION_KEY_V1}; keeping a quarantine copy: ${detail}`,
    );
    persistMemento(workspaceState, SESSION_KEY_V1_CORRUPT, {
      quarantinedAt: Date.now(),
      value: rawV1,
    });
  }

  const legacy =
    workspaceState.get<Array<{ role: 'user' | 'assistant'; content: string }>>(HISTORY_KEY_LEGACY);
  if (legacy?.length) {
    const migrated = migrateLegacyHistory(legacy);
    // Preserve the legacy record until a later successful cleanup. Clearing it
    // here could erase the only durable copy when the replacement hits quota.
    persistMemento(workspaceState, SESSION_KEY_V1, runtimeToPersisted(migrated));
    archive?.overflow.list(migrated.conversations.map((conversation) => conversation.id));
    return migrated;
  }

  archive?.overflow.list();
  return createDefaultSession();
}

/**
 * A non-empty memento `history` wins: only a pre-file build, a downgrade, or a
 * save whose file write failed puts one there, and each is newer than the
 * file. An EMPTY one does not — a session whose file was unreadable saves `[]`
 * there, and letting that win would erase the file's archive on the next
 * start. The next save moves a winning memento copy into the file.
 */
function loadHistory(
  persisted: SidebarSessionPersisted,
  archive: HistoryArchive | undefined,
): ConversationPersisted[] {
  if (!archive || (persisted.history?.length ?? 0) > 0) return persisted.history ?? [];
  return archive.load() ?? persisted.history ?? [];
}

/**
 * With an `archive`, history goes to its file and the memento record carries
 * only the open tabs — see `HistoryArchive` for why. A failed file write keeps
 * history in the memento for that save, so it is never dropped.
 */
export function saveSidebarSession(
  workspaceState: Memento,
  session: SidebarRuntime,
  archive?: HistoryArchive,
  overflow?: ArchivedSessions,
): void {
  session.history.sort((a, b) => b.updatedAt - a.updatedAt);
  if (overflow && session.history.length > MAX_HISTORY_CONVERSATIONS) {
    const evicted = session.history.slice(MAX_HISTORY_CONVERSATIONS);
    for (const conversation of evicted)
      overflow.put(
        runtimeToPersisted({
          activeConversationId: conversation.id,
          conversations: [conversation],
          history: [],
        }).conversations[0]!,
      );
    session.history = session.history.slice(0, MAX_HISTORY_CONVERSATIONS);
  } else if (!overflow) {
    session.history = session.history.slice(0, MAX_HISTORY_CONVERSATIONS);
  }
  const inFile = archive?.save(session.history, () => session.history.map(conversationToPersisted));
  persistMemento(
    workspaceState,
    SESSION_KEY_V1,
    runtimeToPersisted(session, { withHistory: inFile !== true }),
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
