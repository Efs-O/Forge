/**
 * Model-facing message preparation for one turn: compaction window, image
 * age-out, system prompt, turn context, and tool-result excerpting. Extracted
 * from `runModelTurn` (see docs/plans/SOURCE_SPLIT_PLAN.md, Phase 1).
 *
 * The ORDER of the transformations is behaviour — see
 * `test/unit/promptPrefixStability.test.ts`. Do not reorder.
 */
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { ConversationRuntime } from './sessionTypes';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import type { ToolDefinition, ChatMessage } from '../llm/types';
import { estimateToolTokens } from '../util/contextBudget';
import { stampToolResultClocks } from '../agent/toolResultClock';
import { prepareToolResultContext } from '../agent/toolResultContext';
import { annotateRereads } from '../agent/staleReadSupersede';
import { nudgeTruncatedResults } from '../agent/truncatedResultNudge';
import { applyCompactionWindow } from './compactionWindow';
import { ageOutImageParts, stripImageParts } from './imageParts';
import { injectSystemPrompt } from '../llm/SystemPromptInjector';
import { injectTurnContext, type TurnContextState } from './turnContext';
import { buildTemplateContext } from './turnModelBehavior';
import { attachCurrentTaskReasoning, preservesThinking } from '../agent/preserveThinking';

export interface PrepareModelTurnMessagesInput {
  compaction: ConversationRuntime['compaction'];
  isVisionModel: boolean;
  model: ModelConfig;
  templateEngine: TemplateEngine | undefined;
  config: ForgeConfig;
  forgeLoader: ForgeInstructionsLoader | undefined;
  activeFile: string | undefined;
  turnContext: TurnContextState;
  getToolDefinitions: () => ToolDefinition[];
}

export function prepareModelTurnMessages(
  messages: ChatMessage[],
  input: PrepareModelTurnMessagesInput,
): ChatMessage[] {
  // Compaction shrinks what the MODEL sees, never the stored transcript.
  // The loop hands us a copy and re-runs this every round, so the window
  // holds for the whole turn without touching conv.messages.
  const windowed = applyCompactionWindow(messages, input.compaction);
  // The one place images ever leave the model-facing copy. Aging and the
  // no-vision strip are mutually exclusive: on a projector-less model the
  // `no-vision` note wins, because it explains why the image is missing
  // now rather than implying it can be recovered by re-calling view_image.
  //
  // Runs AFTER the window (no point rewriting messages it drops) and
  // BEFORE injection/excerpting, so the freed tokens reach the budget math.
  const visible = input.isVisionModel
    ? ageOutImageParts(windowed, input.model.image_retention_turns)
    : stripImageParts(windowed, {
        reason: 'no-vision',
        modelName: input.model.name,
      });
  const injected = injectSystemPrompt(
    visible,
    input.templateEngine,
    buildTemplateContext(input.config, input.forgeLoader, input.activeFile),
    input.model.system_prompt,
    input.model.system_prompt_mode,
  );
  // Only the model-facing copy is reduced. `conv.messages` remains the
  // full raw transcript for sidebar, persistence, and exact recovery via
  // read_tool_result when an excerpt calls for more detail.
  // Runs BEFORE the excerpting below so the budget sees the freed room:
  // on a turn that would not otherwise fit, the surviving results get
  // excerpted less aggressively.
  // Layer C last, so the volatile block lands as close to the tail as a
  // strict chat template allows. Everything above it -- system prompt and
  // the whole conversation -- stays byte-identical while the active file
  // or the plan changes, which is what keeps the KV cache warm. The state
  // is the turn-start snapshot above, so it is byte-identical across the
  // rounds WITHIN this turn too.
  const withTurnContext = injectTurnContext(injected, input.turnContext);
  // After the window and injection, so the task boundary is read from what the
  // model actually sees; before excerpting, so the budget counts the thinking
  // and drops it oldest-first ahead of cutting any tool result.
  const withThinking = preservesThinking(input.model)
    ? attachCurrentTaskReasoning(withTurnContext)
    : withTurnContext;
  return prepareToolResultContext({
    messages: stampToolResultClocks(nudgeTruncatedResults(annotateRereads(withThinking))),
    toolTokens: estimateToolTokens(input.getToolDefinitions()),
    model: input.model,
    server: input.config.llama_server,
  }).messages;
}
