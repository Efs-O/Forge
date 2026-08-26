import type { RegisteredTool } from './ToolRegistry';
import type { ToolDefinition } from '../llm/types';
import type { LocalDelegationService } from '../delegation/LocalDelegationService';
import type { ForgeConfig } from '../config/types';
import {
  listEligibleDelegationTargets,
  resolveDelegationTarget,
  type EligibleDelegationTarget,
} from '../delegation/eligibility';
import {
  MAX_DELEGATION_TASK_CHARS,
  MAX_DELEGATION_CONTEXT_FILES,
  HARD_MAX_DELEGATION_OUTPUT_TOKENS,
} from '../delegation/limits';

const FOCUS_VALUES = [
  'correctness',
  'security',
  'tests',
  'architecture',
  'performance',
  'second-opinion',
] as const;

/** Returns true when at least one configured model can accept a delegation. */
export function hasEligibleDelegationTargets(config: ForgeConfig): boolean {
  for (const model of config.models) {
    try {
      resolveDelegationTarget(config, model.name);
      return true;
    } catch {
      // model is not eligible
    }
  }
  return false;
}

const KIND_LABELS: Record<EligibleDelegationTarget['provider'], string> = {
  'llama.cpp': 'local',
  ollama: 'local Ollama',
  cloud: 'cloud',
  cli: 'CLI agent, has its own tools',
};

/**
 * Names the callable targets inside the `model` arg description.
 *
 * Deliberately NOT a JSON Schema `enum`: resolveRequestModel also accepts
 * aliases, short_names and `base@profile` forms, and an enum would reject every
 * one of them. This is a hint, and the handler stays the real gate.
 */
export function describeDelegationTargets(config: ForgeConfig): string {
  const targets = listEligibleDelegationTargets(config);
  if (targets.length === 0) return '';
  const listed = targets.map((t) => `"${t.name}" (${KIND_LABELS[t.provider]})`).join(', ');
  return ` Configured targets: ${listed}. Aliases, short_names and "model@profile" also resolve.`;
}

/**
 * Returns the advertised definition: the canonical literal with the current
 * config's target list spliced into the `model` arg description.
 *
 * The literal stays the canonical `definition` (scripts/tool-audit-catalog.mjs
 * extracts it statically from source); this only rewrites one description
 * string, so the tool name and schema shape are unchanged.
 */
const MODEL_ARG_DESCRIPTION =
  'Model to delegate to. Pass a name exactly as listed here — do NOT read config.yaml to find one.';

function describeWithTargets(base: ToolDefinition, config: ForgeConfig): ToolDefinition {
  const hint = describeDelegationTargets(config);
  if (!hint) return base;
  const params = base.function.parameters as {
    properties: { model: { description: string } };
  };
  return {
    ...base,
    function: {
      ...base.function,
      parameters: {
        ...base.function.parameters,
        properties: {
          ...params.properties,
          model: { ...params.properties.model, description: MODEL_ARG_DESCRIPTION + hint },
        },
      },
    },
  };
}

/**
 * Creates the ask_local_agent tool.
 * Advertised only when the 'delegate' permission is granted AND at least one
 * eligible local target exists. The handler also enforces the eligibility
 * check so the tool is blocked even if called outside its advertised window.
 */
export function makeLocalAgentTool(
  delegationService: LocalDelegationService,
  getConfig: () => ForgeConfig,
): RegisteredTool {
  const tool: RegisteredTool = {
    definition: {
      type: 'function',
      function: {
        name: 'ask_local_agent',
        description:
          'Delegate an analysis task to a secondary model: a local llama.cpp or Ollama model, a ' +
          'configured cloud model (xAI, OpenRouter, OpenAI-compatible — this is how you reach ' +
          'OpenRouter), or a provider: cli external agent (Claude Code, Codex). Use for second ' +
          'opinions, security reviews, test suggestions, or correctness checks. Local and cloud ' +
          'models receive only the task and optional context files — they have no tools. A cli ' +
          'target instead runs read-only with ITS OWN tools (it can read/list files itself) but is ' +
          'instructed not to modify anything. ' +
          'This tool requires only the delegate permission; do not request terminal, write, or other permissions.',
        parameters: {
          type: 'object',
          properties: {
            model: {
              type: 'string',
              description: MODEL_ARG_DESCRIPTION,
            },
            task: {
              type: 'string',
              maxLength: MAX_DELEGATION_TASK_CHARS,
              description: `Analysis task to send to the delegated model. Max ${MAX_DELEGATION_TASK_CHARS} characters.`,
            },
            context_files: {
              type: 'array',
              items: { type: 'string' },
              maxItems: MAX_DELEGATION_CONTEXT_FILES,
              description: `Workspace-relative file paths to supply as read-only context (max ${MAX_DELEGATION_CONTEXT_FILES}).`,
            },
            focus: {
              type: 'string',
              enum: [...FOCUS_VALUES],
              description: 'Optional analysis focus hint.',
            },
            max_output_tokens: {
              type: 'integer',
              minimum: 1,
              maximum: HARD_MAX_DELEGATION_OUTPUT_TOKENS,
              description: `Max tokens the delegated model may produce (1–${HARD_MAX_DELEGATION_OUTPUT_TOKENS}).`,
            },
          },
          required: ['model', 'task'],
          additionalProperties: false,
        },
      },
    },
    // ToolRegistry.definitions() runs every agent turn, so a model added to
    // config.yaml shows up in the advertised target list without a reload.
    describe: () => describeWithTargets(tool.definition, getConfig()),
    permission: 'delegate',
    advertise: () => hasEligibleDelegationTargets(getConfig()),
    handler: async (args, context) => {
      if (!hasEligibleDelegationTargets(getConfig())) {
        throw new Error(
          'ask_local_agent: no eligible delegation targets are configured. ' +
            'Add a local llama.cpp or Ollama model, a configured cloud model, or a ' +
            'provider: cli agent to config.yaml.',
        );
      }
      const config = getConfig();
      const primaryModel = config.active_model ?? '';
      const contextFiles = args['context_files'] as string[] | undefined;
      const focus = args['focus'] as string | undefined;
      const maxOutputTokens = args['max_output_tokens'] as number | undefined;
      const signal = context?.abortSignal;
      const conversationId = context?.conversationId;
      const result = await delegationService.ask({
        primaryModel,
        targetModel: args['model'] as string,
        task: args['task'] as string,
        ...(contextFiles !== undefined ? { contextFiles } : {}),
        ...(focus !== undefined ? { focus } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(signal !== undefined ? { signal } : {}),
        ...(conversationId !== undefined ? { conversationId } : {}),
      });
      const bestEffortNote = result.bestEffort ? ' [best-effort: shared slot]' : '';
      return `[Delegated analysis — ${result.targetModel}${bestEffortNote}]\n\n${result.text}`;
    },
  };
  return tool;
}
