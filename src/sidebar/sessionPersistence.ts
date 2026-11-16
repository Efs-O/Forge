import type { Memento } from 'vscode';
import { repairInterruptedToolCalls } from './interruptedToolCalls';
import type { CompactionState } from './compactionTypes';
import type { ForgeInstructionsPin } from './forgeInstructionsPin';
import { rebuildIndex } from '../agentLinks/chatAgentLinks';
import type { HistoryArchive } from './HistoryArchive';
import { persistedRetentionState, runtimeRetentionState } from './conversationRetentionState';
import { seedChatHostApprovals } from './chatApprovalRules';
import { opResetReportedContext } from './ConversationOps';
import { openConversationsPersistenceFor, persistMemento } from './openConversationsPersistence';
import { copyQuestionRecords } from './sessionQuestionRecords';
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
    retention_activity_at: now,
    keep_open: false,
    clanker: false,
    messages: [],
  };
}

function copyPin(pin: {
  text: string;
  windowStart: number;
  announced?: { text: string; messageIndex: number } | undefined;
}): ForgeInstructionsPin {
  return {
    text: pin.text,
    windowStart: pin.windowStart,
    ...(pin.announced ? { announced: { ...pin.announced } } : {}),
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
  resumeNote?: CompactionState['resumeNote'] | undefined;
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
    ...(compaction.resumeNote ? { resumeNote: { ...compaction.resumeNote } } : {}),
  };
}

export function createDefaultSession(): SidebarRuntime {
  const id = newConversationId();
  const now = Date.now();
  const conversation = emptyConversation(id, now);
  return {
    activeConversationId: id,
    conversations: [conversation],
    history: [],
  };
}

export function persistedToRuntime(p: ConversationPersisted): ConversationRuntime {
  const conversation: ConversationRuntime = {
    id: p.id,
    title: p.title,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...persistedRetentionState(p),
    messages: repairInterruptedToolCalls(chatMessagesFromSlim(p.messages)),
    ...(p.agentLinks !== undefined ? { agentLinks: { ...p.agentLinks } } : {}),
    ...(p.opened_by !== undefined ? { opened_by: p.opened_by } : {}),
    ...(p.active_model !== undefined ? { active_model: p.active_model } : {}),
    ...(p.cli_sessions !== undefined ? { cli_sessions: { ...p.cli_sessions } } : {}),
    ...(p.compaction !== undefined ? { compaction: copyCompaction(p.compaction) } : {}),
    ...(p.plan !== undefined
      ? { plan: { ...p.plan, items: p.plan.items.map((i) => ({ ...i })) } }
      : {}),
    ...(p.forge_instructions_pin !== undefined
      ? { forgeInstructionsPin: copyPin(p.forge_instructions_pin) }
      : {}),
    ...(p.coding_tips_pin !== undefined ? { codingTipsPin: { ...p.coding_tips_pin } } : {}),
    ...(p.display_diffs !== undefined
      ? { displayDiffs: p.display_diffs.map((diff) => ({ ...diff })) }
      : {}),
    ...(p.display_question_records !== undefined
      ? { displayQuestionRecords: copyQuestionRecords(p.display_question_records) }
      : {}),
    ...(p.display_notices !== undefined
      ? { displayNotices: p.display_notices.map((notice) => ({ ...notice })) }
      : {}),
    ...(p.active_time_ms !== undefined ? { active_time_ms: p.active_time_ms } : {}),
    ...(p.active_started_at !== undefined ? { active_started_at: p.active_started_at } : {}),
    ...(p.input_tokens !== undefined ? { input_tokens: p.input_tokens } : {}),
    ...(p.output_tokens !== undefined ? { output_tokens: p.output_tokens } : {}),
    ...(p.last_input_tokens !== undefined ? { last_input_tokens: p.last_input_tokens } : {}),
    ...(p.last_output_tokens !== undefined ? { last_output_tokens: p.last_output_tokens } : {}),
    ...(p.model_request_count !== undefined ? { model_request_count: p.model_request_count } : {}),
    ...(p.tool_call_count !== undefined ? { tool_call_count: p.tool_call_count } : {}),
    ...(p.untrusted_since_ms !== undefined ? { untrusted_since_ms: p.untrusted_since_ms } : {}),
    ...(p.approval_rules !== undefined ? { approval_rules: [...(p.approval_rules ?? [])] } : {}),
    ...(p.clankerSource === 'policy-default'
      ? { clanker: false }
      : p.clanker !== undefined
        ? { clanker: p.clanker }
        : {}),
  };
  // Older builds saved before clearing usage. With the cut at the transcript
  // end, no later model response could have measured the compacted context.
  if (p.compaction?.fromIndex === p.messages.length) opResetReportedContext(conversation);
  seedChatHostApprovals(conversation);
  return conversation;
}

/** The reload repair lives in `interruptedToolCalls.ts`; re-exported so
 *  `compactionLedger.ts` and the archive tests keep one import path. */
export { TOOL_INTERRUPTED_RESULT } from './interruptedToolCalls';

function conversationToPersisted(c: ConversationRuntime): ConversationPersisted {
  return {
    id: c.id,
    title: c.title,
    // Who started the chat, when a bus prompt did. It has to travel with the
    // record: the sessions panel badges a chat from it, and the overflow
    // archive's index row is built from this same object.
    ...(c.origin_agent !== undefined ? { origin_agent: c.origin_agent } : {}),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    ...runtimeRetentionState(c),
    messages: slimPersistMessages(c.messages),
    ...(c.agentLinks !== undefined ? { agentLinks: { ...c.agentLinks } } : {}),
    ...(c.opened_by !== undefined ? { opened_by: c.opened_by } : {}),
    ...(c.active_model !== undefined ? { active_model: c.active_model } : {}),
    ...(c.cli_sessions !== undefined ? { cli_sessions: { ...c.cli_sessions } } : {}),
    ...(c.compaction !== undefined ? { compaction: copyCompaction(c.compaction) } : {}),
    ...(c.plan !== undefined
      ? { plan: { ...c.plan, items: c.plan.items.map((i) => ({ ...i })) } }
      : {}),
    ...(c.forgeInstructionsPin !== undefined
      ? { forge_instructions_pin: copyPin(c.forgeInstructionsPin) }
      : {}),
    ...(c.codingTipsPin !== undefined ? { coding_tips_pin: { ...c.codingTipsPin } } : {}),
    ...(c.displayDiffs !== undefined
      ? { display_diffs: c.displayDiffs.map((diff) => ({ ...diff })) }
      : {}),
    ...(c.displayQuestionRecords !== undefined
      ? { display_question_records: copyQuestionRecords(c.displayQuestionRecords) }
      : {}),
    ...(c.displayNotices !== undefined
      ? { display_notices: c.displayNotices.map((notice) => ({ ...notice })) }
      : {}),
    ...(c.active_time_ms !== undefined ? { active_time_ms: c.active_time_ms } : {}),
    ...(c.active_started_at !== undefined ? { active_started_at: c.active_started_at } : {}),
    ...(c.input_tokens !== undefined ? { input_tokens: c.input_tokens } : {}),
    ...(c.output_tokens !== undefined ? { output_tokens: c.output_tokens } : {}),
    ...(c.last_input_tokens !== undefined ? { last_input_tokens: c.last_input_tokens } : {}),
    ...(c.last_output_tokens !== undefined ? { last_output_tokens: c.last_output_tokens } : {}),
    ...(c.model_request_count !== undefined ? { model_request_count: c.model_request_count } : {}),
    ...(c.tool_call_count !== undefined ? { tool_call_count: c.tool_call_count } : {}),
    ...(c.untrusted_since_ms !== undefined ? { untrusted_since_ms: c.untrusted_since_ms } : {}),
    ...(c.approval_rules !== undefined ? { approval_rules: [...(c.approval_rules ?? [])] } : {}),
    ...(c.clanker !== undefined ? { clanker: c.clanker } : {}),
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
        // The name came from the first prompt of the migrated session, so it is
        // marked `prompt` and the daily retitle job may replace it.
        title_source: 'prompt',
        createdAt: now,
        updatedAt: now,
        retention_activity_at: now,
        keep_open: false,
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
): SidebarRuntime {
  const openPersistence = openConversationsPersistenceFor(
    workspaceState,
    archive?.openConversations,
  );
  // Clanker used to be a window-wide key here, armed by one tab and felt by every
  // one. It is a chat's now, stored on the chat's own record (`chatClanker.ts`), so
  // the old value is cleared once: nothing reads it, and a leftover would be a mode
  // the owner can neither see nor turn off. Written directly rather than through
  // `persistMemento`, because that chains writes behind each other and this one has
  // to land before the flag is first read, not after the last save.
  void workspaceState.update('forge.clankerMode', undefined);
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
    return indexSession(migrated, archive);
  }

  const session = createDefaultSession();
  session.history = (archive?.load() ?? []).map(persistedToRuntime);
  archive?.overflow.list([
    ...session.conversations.map((conversation) => conversation.id),
    ...session.history.map((conversation) => conversation.id),
  ]);
  return indexSession(session, archive);
}

/**
 * Rebuild the agent-session index from every record this load brings in.
 * Several chats may hold the same agent session now, so there is no conflict
 * left to report: the newest `lastUsedAt` is simply the chat the session
 * addresses next, and the rest stay reachable with `--to`
 * (docs/plans/V1_FINISH_PLAN.md lane 4 phase 5).
 */
function indexSession(session: SidebarRuntime, archive?: HistoryArchive): SidebarRuntime {
  rebuildIndex(agentLinkRecords(session, archive));
  return session;
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
): Promise<boolean> {
  session.history.sort((a, b) => b.updatedAt - a.updatedAt);
  // Past the cap, chats are evicted to the archive, not dropped. Without a
  // folder (no archive) they are dropped, as they always were.
  for (const conversation of session.history.slice(MAX_HISTORY_CONVERSATIONS)) {
    archive?.overflow.put(conversationToPersisted(conversation));
  }
  session.history = session.history.slice(0, MAX_HISTORY_CONVERSATIONS);
  const inFile = archive?.save(session.history, conversationToPersisted);
  const historyFallback = inFile === true ? [] : session.history.map(conversationToPersisted);
  const saved = openConversationsPersistenceFor(workspaceState, archive?.openConversations).save(
    workspaceState,
    session,
    conversationToPersisted,
    historyFallback,
    changedId,
    archive ? () => archive.pruneRemoved() : undefined,
  );
  // Keep the pointer in step so it is always the authoritative answer on load,
  // rather than a value that may be older than the blob beside it.
  // The returned promise covers the pointer too: a caller that awaits the save
  // (a reload, a test) must not read the store between the two writes.
  const pointer = persistMemento(workspaceState, ACTIVE_ID_KEY, session.activeConversationId);
  return Promise.all([saved, pointer]).then(([blob, active]) => blob && active);
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
