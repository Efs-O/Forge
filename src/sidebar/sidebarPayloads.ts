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
import type { HostToWebview, ModelResidency } from './messageBridge';
import { classifyModelRoute } from '../llm/ModelRouteClassifier';
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
/** Residency the pool can speak to. Remote routes get `undefined` — see
 *  `ModelEntry.residency`. */
function residencyOf(
  model: Parameters<typeof modelPickerGroup>[0],
  pool: ModelResidencySource | undefined,
): ModelResidency | undefined {
  if (!pool) return undefined;
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
      const residency = residencyOf(model, pool);
      // Spread rather than assign undefined: exactOptionalPropertyTypes draws a
      // distinction between an absent key and an explicit undefined, and
      // "no dot" is the absent case.
      return {
        name: model.name,
        provider: model.provider ?? 'llama.cpp',
        group: modelPickerGroup(model),
        ...(residency ? { residency } : {}),
      };
    }),
    active: activeModel,
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
