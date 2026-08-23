/**
 * What the host reports outward: the model picker's contents, the session
 * snapshot the webview renders tabs from, and the metrics the status bar shows.
 *
 * Split out of `SidebarProvider`, which owns the wiring and the lifecycle.
 * Everything here is a pure projection of config/session state into a payload —
 * no posting, no mutation — so each can be asserted directly in a test.
 */

import type { ForgeConfig } from '../config/types';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import { historyMetasFromSession, slimMessagesById, tabMetasFromSession } from './sessionTypes';
import { modelPickerGroup } from './ModelPickerGroups';
import { reportedContextTokens } from '../util/contextBudget';
import type { SessionTimeSnapshot } from '../vscode/SessionTimeStatusBar';

/**
 * The model list and current selection for the picker.
 *
 * Must follow every change of active conversation: `sessionSync` carries no
 * model, and the webview's selection is only ever set from this message, so a
 * tab switch used to leave the header showing the previous tab's model while
 * the host had already switched to this tab's.
 */
export function buildModelsMessage(config: ForgeConfig): HostToWebview {
  return {
    type: 'models',
    models: config.models.map((configured) => {
      const model = mergeGroupsIntoModel(config, configured);
      return {
        name: model.name,
        provider: model.provider ?? 'llama.cpp',
        group: modelPickerGroup(model),
      };
    }),
    active: config.active_model,
  };
}

/** Tabs, history and slimmed transcripts — everything the webview redraws from. */
export function buildSessionSyncMessage(
  sidebar: SidebarRuntime,
  streamingIds: ReadonlySet<string>,
  sessionActiveMs: (conversation: ConversationRuntime) => number,
): HostToWebview {
  return {
    type: 'sessionSync',
    activeId: sidebar.activeConversationId,
    tabs: tabMetasFromSession(sidebar, streamingIds, sessionActiveMs),
    history: historyMetasFromSession(sidebar),
    messagesById: slimMessagesById(sidebar),
  };
}

/**
 * Feeds the status bar. `contextTokens` is deliberately the same
 * `reportedContextTokens` value the sidebar bar and the HalluMeter bridge
 * render: it used to be `last_input_tokens` alone, so the two displays
 * disagreed by the size of the last completion.
 */
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
  };
}
