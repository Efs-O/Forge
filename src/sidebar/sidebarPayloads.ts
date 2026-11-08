/**
 * What the host reports outward: the model picker's contents, the session
 * snapshot the webview renders tabs from, and the metrics the status bar shows.
 *
 * Split out of `SidebarProvider`, which owns the wiring and the lifecycle.
 * Everything here is a pure projection of config/session state into a payload —
 * no posting, no mutation — so each can be asserted directly in a test.
 */

import type { ForgeConfig } from '../config/types';
import type { ArchivedSessionMeta } from './ArchivedSessions';
import { availableProfilesFor, mergeGroupsIntoModel } from '../config/ConfigResolver';
import type { HostToWebview, ModelResidency, SessionSyncMsg } from './messageBridge';
import type { HistoryPanelSize } from './historyPanelSize';
import { withOriginChannel } from './chatProvenance';
import { classifyModelRoute } from '../llm/ModelRouteClassifier';
import { isManagedExternalModel } from '../backend/ExternalModelServers';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import {
  historyMetasFromSession,
  displayTranscriptRowsById,
  tabMetasFromSession,
} from './sessionProjections';
import { describeModelPickerModel } from './ModelPickerGroups';
import { reportedContextTokens } from '../util/contextBudget';
import type { SessionTimeSnapshot } from '../vscode/SessionTimeStatusBar';
import type { LiveStreamEstimate } from './LiveStreamMeter';
import type { UserQuestionRequestEvent } from './UserQuestionService';

/**
 * The picker payload for a live session: `buildModelsMessage` plus which
 * conversation's pin applies. The active tab's pin beats the config default
 * because that is what sending does, and this is the projection that has the
 * session in hand — `SidebarProvider` used to do the lookup itself, and the
 * provider is at this repo's 500-line stop while a new panel bridge needs room.
 */
export function modelsMessageFor(
  sidebar: SidebarRuntime,
  config: ForgeConfig,
  pool?: ModelResidencySource,
): HostToWebview {
  const active = sidebar.conversations.find(
    (conversation) => conversation.id === sidebar.activeConversationId,
  );
  return buildModelsMessage(config, pool, active?.active_model ?? config.active_model);
}

/**
 * The model list and current selection for the picker.
 *
 * Must follow every change of active conversation: `sessionSync` carries no
 * model, and the webview's selection is only ever set from this message, so a
 * tab switch used to leave the header showing the previous tab's model while
 * the host had already switched to this tab's.
 */
/** Residency the pool can speak to. Remote routes get `undefined` — see
 *  `ModelEntry.residency`. */
function residencyOf(
  model: Parameters<typeof describeModelPickerModel>[0],
  pool: ModelResidencySource | undefined,
): ModelResidency | undefined {
  if (!pool) return undefined;
  // Strata-style servers are openai-compatible, so they route as cloud, but
  // Forge loads and unloads them: ready once used, cold after an unload.
  if (isManagedExternalModel(model)) return pool.isModelReady(model.name) ? 'ready' : 'cold';
  const route = classifyModelRoute(model);
  if (route !== 'local-llama' && route !== 'local-ollama') return undefined;
  if (!pool.isLoaded(model.name)) return 'cold';
  return pool.isModelReady(model.name) ? 'ready' : 'loading';
}

/** The slice of the pool this projection needs, so tests need not build one. */
export interface ModelResidencySource {
  isLoaded(modelName: string): boolean;
  isModelReady(modelName: string): boolean;
}

export function buildModelsMessage(
  config: ForgeConfig,
  pool?: ModelResidencySource,
  /** The active tab's pin wins over the config default, just like sending does. */
  activeModel: string | null = config.active_model,
): HostToWebview {
  return {
    type: 'models',
    models: config.models.map((configured) => {
      const model = mergeGroupsIntoModel(config, configured);
      const profiles = availableProfilesFor(config, model.name);
      const residency = residencyOf(model, pool);
      const picker = describeModelPickerModel(model);
      // Spread rather than assign undefined: exactOptionalPropertyTypes draws a
      // distinction between an absent key and an explicit undefined, and
      // "no dot" is the absent case.
      return {
        ...picker,
        provider: model.provider ?? 'llama.cpp',
        ...(profiles.length > 0 ? { profiles } : {}),
        ...(residency ? { residency } : {}),
      };
    }),
    active: activeModel,
  };
}

/**
 * Tabs, history and slimmed transcripts — everything the webview redraws from.
 *
 * Transcripts are limited to what the webview can render this instant: the
 * active tab, plus anything streaming (a background turn still has to reconcile
 * its tool rows). Shipping all 52 conversations, as this did, is what made a tab
 * switch cost 1–2 s — see `docs/plans/SIDEBAR_SWITCH_LATENCY_PLAN.md`. The
 * active id is always in the set, so the webview can never be told to show a
 * tab it has no rows for; it treats `messagesById` as a partial update and
 * caches the rest, so an absent id means "unchanged", never "empty".
 */
export function buildSessionSyncMessage(
  sidebar: SidebarRuntime,
  streamingIds: ReadonlySet<string>,
  sessionActiveMs: (conversation: ConversationRuntime) => number,
  attachmentsRoot?: string,
  waitingIds: ReadonlySet<string> = new Set<string>(),
  archived: ArchivedSessionMeta[] = [],
  historyPanelSize?: HistoryPanelSize,
  /** Which remote chat each conversation id is bound to, for the phone badge. */
  originChannelOf?: (conversationId: string) => string | undefined,
  legacyGlobalIds: ReadonlySet<string> = new Set(),
): SessionSyncMsg {
  const wanted = new Set<string>([sidebar.activeConversationId, ...streamingIds]);
  // A row can briefly duplicate a chat that was just restored; the open/recent copy wins.
  const overflowRows = archived
    .filter(
      (row) =>
        !sidebar.conversations.some((c) => c.id === row.id) &&
        !sidebar.history.some((c) => c.id === row.id),
    )
    .map(
      ({
        id,
        title,
        createdAt,
        updatedAt,
        messageCount,
        active_model,
        title_source,
        origin_agent,
      }) => ({
        id,
        title,
        createdAt,
        updatedAt,
        messageCount,
        ...(active_model ? { active_model } : {}),
        // Both provenance fields ride along, so an archived row badges exactly
        // like the same chat would have when it was still in recent history.
        ...(title_source ? { title_source } : {}),
        ...(origin_agent ? { origin_agent } : {}),
      }),
    );
  return {
    type: 'sessionSync',
    activeId: sidebar.activeConversationId,
    // The phone badge is stamped here rather than in the projections: this is
    // the one place holding both the ids the panel will draw and the binding
    // read the caller brought along.
    tabs: withOriginChannel(
      tabMetasFromSession(sidebar, streamingIds, sessionActiveMs),
      originChannelOf,
    ),
    history: withOriginChannel(historyMetasFromSession(sidebar), originChannelOf).map((row) =>
      legacyGlobalIds.has(row.id) ? { ...row, legacy_global: true } : row,
    ),
    archived: withOriginChannel(overflowRows, originChannelOf).map((row) =>
      legacyGlobalIds.has(row.id) ? { ...row, legacy_global: true } : row,
    ),
    waitingIds: [...waitingIds].filter(Boolean),
    messagesById: displayTranscriptRowsById(sidebar, wanted),
    ...(attachmentsRoot ? { attachmentsRoot } : {}),
    // Read from `globalState` by the caller: this file projects, it does not own
    // the store the size lives in.
    ...(historyPanelSize ? { historyPanelSize } : {}),
  };
}

/** The slice of the agent loop the status-bar metrics projection needs. */
export interface SessionActivitySource {
  getSessionActiveMs(conversation: ConversationRuntime): number;
  getLiveStream(conversationId: string): LiveStreamEstimate | undefined;
}

/**
 * `buildFollowedSessionMetrics` with the agent loop handed over whole, so the
 * provider's status-bar call is one line rather than five thunks.
 */
export function followedSessionMetricsFor(
  sidebar: SidebarRuntime,
  active: ConversationRuntime,
  activity: SessionActivitySource,
  followedId: string | undefined,
): SessionTimeSnapshot {
  return buildFollowedSessionMetrics(
    sidebar,
    active,
    followedId,
    (conversation) => activity.getSessionActiveMs(conversation),
    (conversationId) => activity.getLiveStream(conversationId),
  );
}

/**
 * Feeds the status bar. `contextTokens` is deliberately the same
 * `reportedContextTokens` value the sidebar bar and the HalluMeter bridge
 * render: it used to be `last_input_tokens` alone, so the two displays
 * disagreed by the size of the last completion.
 */
/** The sidebar's rendering of a question the agent asked (`ask_user`). */
export function buildQuestionMessage(event: UserQuestionRequestEvent): HostToWebview {
  return {
    type: 'question',
    id: event.id,
    prompt: event.prompt,
    specs: event.specs,
    ...(event.placeholder !== undefined ? { placeholder: event.placeholder } : {}),
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
  };
}

/** The streamed-so-far estimate as snapshot fields; nothing while idle. */
export function liveStreamMetrics(
  live: LiveStreamEstimate | undefined,
): Pick<SessionTimeSnapshot, 'liveReasoningTokens' | 'liveAnswerTokens'> {
  return live
    ? { liveReasoningTokens: live.reasoningTokens, liveAnswerTokens: live.answerTokens }
    : {};
}

export function buildSessionMetrics(
  conv: ConversationRuntime,
  activeMs: number,
): SessionTimeSnapshot {
  return {
    activeMs,
    contextTokens: reportedContextTokens(conv),
    ...(conv.input_tokens !== undefined ? { inputTokens: conv.input_tokens } : {}),
    ...(conv.output_tokens !== undefined ? { outputTokens: conv.output_tokens } : {}),
    ...(conv.last_input_tokens !== undefined ? { currentInputTokens: conv.last_input_tokens } : {}),
    ...(conv.last_output_tokens !== undefined
      ? { currentOutputTokens: conv.last_output_tokens }
      : {}),
    ...(conv.model_request_count !== undefined ? { requestCount: conv.model_request_count } : {}),
    ...(conv.tool_call_count !== undefined ? { toolCallCount: conv.tool_call_count } : {}),
    ...(conv.compaction?.generation !== undefined
      ? { compactCount: conv.compaction.generation }
      : {}),
  };
}

/** Metrics for a followed open chat, else the active tab. */
export function buildFollowedSessionMetrics(
  sidebar: SidebarRuntime,
  active: ConversationRuntime,
  followedId: string | undefined,
  activeMs: (conversation: ConversationRuntime) => number,
  live: (conversationId: string) => LiveStreamEstimate | undefined,
): SessionTimeSnapshot {
  const conversation = sidebar.conversations.find((item) => item.id === followedId) ?? active;
  return {
    ...buildSessionMetrics(conversation, activeMs(conversation)),
    ...(conversation.id !== active.id ? { following: conversation.title } : {}),
    ...liveStreamMetrics(live(conversation.id)),
  };
}
