import type { RegisteredTool } from './ToolRegistry';
import type { ToolDefinition } from '../llm/types';
import type { LocalDelegationService } from '../delegation/LocalDelegationService';
import type { ForgeConfig } from '../config/types';
import { listEligibleDelegationTargets } from '../delegation/eligibility';
import type { EligibleDelegationTarget } from '../delegation/eligibility';
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

const KIND_LABELS: Record<EligibleDelegationTarget['provider'], string> = {
  'llama.cpp': 'local',
  ollama: 'local Ollama',
  cloud: 'cloud',
  cli: 'CLI agent, has its own tools',
};

function localOrCloudTargets(config: ForgeConfig): EligibleDelegationTarget[] {
  return listEligibleDelegationTargets(config).filter((target) => target.provider !== 'cli');
}

/** Returns true when at least one configured model can accept a delegation. */
export function hasEligibleDelegationTargets(config: ForgeConfig): boolean {
  return localOrCloudTargets(config).length > 0;
}

/**
 * The full target list, ranked by what it costs to call.
 *
 * This used to be spliced into `ask_local_agent`'s `model` description on every
 * turn: 1027 characters of it against a real config, ~40% spent on ten
 * near-identical GGUF quant names, and every entry weighted the same. It is now
 * returned on demand by `list_delegation_targets` — the `load_tool_group`
 * trade: one round when the agent actually needs the list, nothing on the turns
 * it does not.
 *
 * Ranked rather than enumerated, because the ordering carries the only
 * information that matters at the call site. A CLI agent brings its own tools
 * and its own process; a cloud model costs a request. A local model costs VRAM
 * this machine may not have — DelegationGate counts free slots
 * (`max_simultaneous_models`), not gigabytes, so nothing below it will stop a
 * second large model from being loaded onto a card that cannot hold it.
 *
 * Deliberately NOT a JSON Schema `enum`: resolveRequestModel also accepts
 * aliases, short_names and `base@profile` forms, and an enum would reject every
 * one of them. This is a hint, and the handler stays the real gate.
 */
export function describeDelegationTargets(config: ForgeConfig): string {
  const targets = localOrCloudTargets(config);
  if (targets.length === 0) return '';
  const section = (label: string, matching: readonly EligibleDelegationTarget[]): string =>
    matching.length === 0
      ? ''
      : [label, ...matching.map((t) => `  "${t.name}" (${KIND_LABELS[t.provider]})`), ''].join(
          '\n',
        );
  const cloud = targets.filter((target) => !target.localWeights);
  const local = targets.filter((target) => target.localWeights);
  return (
    section('Cloud. A request, no VRAM:', cloud) +
    section(
      'Local. Loads weights into local VRAM — the user is asked before any of ' +
        'these runs, so pick one only when the task genuinely needs it:',
      local,
    ) +
    'Aliases, short_names, and "model@profile" also work.'
  );
}

/**
 * The always-advertised half of target discovery.
 *
 * It names only the two CLI agents, and only when they are configured: they are
 * the targets worth spending schema budget on every turn, because they read the
 * repository through their own tools instead of needing context files pasted in,
 * and they cost no VRAM. Everything else is one `list_delegation_targets` call
 * away — the trade `load_tool_group` already makes.
 *
 * The static literal stays the canonical `definition`
 * (scripts/tool-audit-catalog.mjs extracts it from source); `describe()` only
 * rewrites this one description string, so the name and schema shape never move.
 */
const MODEL_ARG_DESCRIPTION =
  'Model to delegate to. Do NOT read config.yaml to find one, and do not guess a ' +
  'name: call list_delegation_targets.';

function describeWithTargets(base: ToolDefinition, _config: ForgeConfig): ToolDefinition {
  return base;
}

/**
 * Discovery for `ask_local_agent`, and the reason its schema is small.
 *
 * Separate from ask_local_agent rather than an argument on it, so that asking
 * what the targets are can never accidentally start one.
 */
export function makeListDelegationTargetsTool(getConfig: () => ForgeConfig): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'list_delegation_targets',
        description:
          'List the local and cloud models ask_local_agent can delegate to, ranked by ' +
          'what each costs to call. Use this instead of reading config.yaml or guessing a name.',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    },
    permission: 'delegate',
    // Reading a list from config that the caller already holds the permission
    // to act on. Gating it would only cost a confirmation before the real one.
    autoApprove: true,
    advertise: () => localOrCloudTargets(getConfig()).length > 0,
    handler: async () => {
      const listed = describeDelegationTargets(getConfig());
      return listed === '' ? 'No delegation targets are configured. Do the work yourself.' : listed;
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
          'Delegate a task to a configured local or cloud model. It starts a new, empty session and knows nothing of the current work. Use for independent review or analysis that benefits from another model. Requires the delegate permission.',
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
              description: `The task to delegate (max ${MAX_DELEGATION_TASK_CHARS} characters). A CLI target can implement it, not just analyse it.`,
            },
            context_files: {
              type: 'array',
              items: { type: 'string' },
              maxItems: MAX_DELEGATION_CONTEXT_FILES,
              description: `Workspace paths to start from (max ${MAX_DELEGATION_CONTEXT_FILES}).`,
            },
            focus: {
              type: 'string',
              enum: [...FOCUS_VALUES],
              description: 'Optional focus hint.',
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
    describe: () => describeWithTargets(tool.definition, getConfig()),
    permission: 'delegate',
    // Confirm before a delegation loads weights into local VRAM. DelegationGate
    // is a SLOT count (`max_simultaneous_models`), not a memory budget: with it
    // set to 4 on a single 16 GB card, delegating from a resident 27B to another
    // large GGUF passes every check Forge makes and then thrashes WDDM instead
    // of failing, which is the worst shape a failure can take — silent. The
    // person who knows what is already resident is the user, so ask them. Cloud
    // targets take no slot and are not gated; CLI targets are, for their access.
    approval: (args) => {
      const requested = args['model'];
      if (typeof requested !== 'string') return undefined;
      const target = localOrCloudTargets(getConfig()).find((item) => item.name === requested);
      const cliTarget = listEligibleDelegationTargets(getConfig()).find(
        (item) => item.name === requested && item.provider === 'cli',
      );
      if (cliTarget) return { detail: 'Use ask_agent for linked CLI sessions.' };
      // An unmatched name is a fuzzy alias/short_name/`model@profile` the
      // handler still resolves. Confirm it: unknown-to-us must not mean ungated.
      if (target && !target.localWeights) return undefined;
      return {
        detail:
          `Delegate to "${requested}", which loads weights into local VRAM ` +
          'alongside the model already running. Confirm only if this machine has ' +
          'room for both.',
      };
    },
    advertise: () => localOrCloudTargets(getConfig()).length > 0,
    handler: async (args, context) => {
      if (localOrCloudTargets(getConfig()).length === 0) {
        throw new Error(
          'ask_local_agent: no eligible delegation targets are configured. ' +
            'Add a local llama.cpp or Ollama model, or a configured cloud model.',
        );
      }
      const config = getConfig();
      const cliTarget = listEligibleDelegationTargets(config).find(
        (item) => item.name === args['model'] && item.provider === 'cli',
      );
      if (cliTarget)
        return 'Error: CLI agents are contacted with ask_agent; ask_local_agent accepts local and cloud models.';
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
