import type { RegisteredTool } from './ToolRegistry';
import type { LocalDelegationService } from '../delegation/LocalDelegationService';
import type { ForgeConfig } from '../config/types';
import { resolveDelegationTarget } from '../delegation/eligibility';
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

/** Returns true when at least one configured model can accept a local delegation. */
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
  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_local_agent',
        description:
          'Delegate an analysis task to a secondary local model or a provider: cli external agent ' +
          '(Claude Code, Codex). Use for second opinions, security reviews, test suggestions, or ' +
          'correctness checks. Regular models receive only the task and optional context files — they ' +
          'have no tools. A cli target instead runs read-only with ITS OWN tools (it can read/list files ' +
          'itself) but is instructed not to modify anything. ' +
          'This tool requires only the delegate permission; do not request terminal, write, or other permissions.',
        parameters: {
          type: 'object',
          properties: {
            model: {
              type: 'string',
              description:
                'Local model name or alias to delegate to (must be a local llama.cpp target, a local Ollama daemon target, or a provider: cli external agent).',
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
    permission: 'delegate',
    advertise: () => hasEligibleDelegationTargets(getConfig()),
    handler: async (args, context) => {
      if (!hasEligibleDelegationTargets(getConfig())) {
        throw new Error(
          'ask_local_agent: no eligible local delegation targets are configured. ' +
            'Add a local llama.cpp or Ollama model to config.yaml.',
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
}
