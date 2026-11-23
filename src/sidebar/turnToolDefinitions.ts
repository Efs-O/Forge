/**
 * The tool list one turn sends, and the extra definitions that only type and
 * admit the tool calls a model writes as text. Both live here so `ModelTurn.ts`
 * stays under its line cap and the two lists cannot drift apart.
 */
import type { ModelConfig } from '../config/types';
import type { ToolDefinition } from '../llm/types';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import type { ToolBudget } from '../tools/ToolBudget';
import { hiddenLazyToolNames } from '../tools/lazyToolGroups';
import type { ToolPermission, ToolRegistry } from '../tools/ToolRegistry';
import type { ConversationRuntime } from './sessionTypes';
import { withPinnedToolTips } from './codingTipsPin';

/** The registry and loader a turn reads its tool list from: the two fields of
 *  `ModelTurnContext` both builders below need, so the turn passes itself. */
export interface TurnToolDefinitionSource {
  toolRegistry: ToolRegistry;
  forgeLoader?: ForgeInstructionsLoader;
}

/**
 * `tool_groups.schemas_in_result` and `text_tool_calls: native` cannot both be
 * on: the switch depends on Forge reading a tool call the model wrote as text,
 * and native turns that channel off. Checked once per turn rather than in
 * `resolveRequestModel`, because that resolver has callers outside a turn that
 * swallow or rewrap a throw (`ControlServer`, `eligibility`, `desktopApprovals`
 * and others); here the turn's own error path shows the message to the user.
 */
export function assertTextCallsReadable(model: ModelConfig): void {
  if (model.tool_groups?.schemas_in_result === true && model.text_tool_calls === 'native') {
    throw new Error(
      'tool_groups.schemas_in_result needs Forge to read tool calls written as text; ' +
        'text_tool_calls: native turns that off. Remove one of the two.',
    );
  }
}

/**
 * Rebuilt on every round rather than snapshotted once per turn: a lazy tool
 * group activates mid-turn via `load_tool_group`, and its schemas have to
 * reach the request that immediately follows.
 */
export function buildToolDefinitions(
  conv: ConversationRuntime,
  model: ModelConfig,
  ctx: TurnToolDefinitionSource,
  allowed: Set<ToolPermission>,
  unattendedRefusals: ReadonlyMap<string, string> | undefined,
  budget: ToolBudget,
): ToolDefinition[] {
  const hiddenLazyTools = hiddenLazyToolNames(
    conv.id,
    new Set(model.tools ?? []),
    new Set(model.tool_groups?.eager ?? []),
  );
  const advertised = ctx.toolRegistry
    .definitions(allowed)
    .filter(
      ({ function: { name } }) => !hiddenLazyTools.has(name) && !unattendedRefusals?.has(name),
    );
  return withPinnedToolTips(conv, ctx.forgeLoader?.root, budget.filterDefinitions(advertised));
}

/**
 * Definitions for registered tools this request does not list, so a call the
 * model wrote as text still gets typed arguments and passes the fenced-JSON
 * name filter. Empty unless `tool_groups.schemas_in_result` is on, which is
 * today's behaviour. Which groups happen to be active does not matter: after a
 * window reload (or in another window) the activation is gone but the schemas
 * are still in the transcript, and the model calls those tools from them.
 * `resultSchemaGroupsByConversation` only decides what is listed, never this.
 * Tool tips are not added: these definitions only type and admit the parsed
 * calls — the model sees the schemas themselves in the load result.
 */
export function buildTextCallDefinitions(
  conv: ConversationRuntime,
  model: ModelConfig,
  ctx: TurnToolDefinitionSource,
  allowed: Set<ToolPermission>,
  unattendedRefusals: ReadonlyMap<string, string> | undefined,
  budget: ToolBudget,
): ToolDefinition[] {
  if (model.tool_groups?.schemas_in_result !== true) return [];
  const listed = new Set(
    buildToolDefinitions(conv, model, ctx, allowed, unattendedRefusals, budget).map(
      (definition) => definition.function.name,
    ),
  );
  const extra = ctx.toolRegistry
    .definitions(allowed)
    .filter(({ function: { name } }) => !listed.has(name) && !unattendedRefusals?.has(name));
  return budget.filterDefinitions(extra);
}
