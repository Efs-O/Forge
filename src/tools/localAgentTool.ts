import type { RegisteredTool } from './ToolRegistry';
import type { LocalDelegationService } from '../delegation/LocalDelegationService';
import type { ForgeConfig } from '../config/types';
import { listEligibleDelegationTargets, resolveDelegationTarget } from '../delegation/eligibility';
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
 * The `model` argument's description. It names no target: one
 * `list_delegation_targets` call lists them, the trade `load_tool_group`
 * already makes.
 *
 * The static literal stays the canonical `definition`
 * (scripts/tool-audit-catalog.mjs extracts it from source).
 */
const MODEL_ARG_DESCRIPTION =
  'Model to delegate to. Do NOT read config.yaml to find one, and do not guess a ' +
  'name: call list_delegation_targets.';

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
          'List the local/cloud models ask_local_agent accepts, ranked by cost. Use instead of ' +
          'reading config.yaml or guessing a name. Linked CLI: use ask_agent.',
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
          'Delegate independent review or analysis to a configured local/cloud model in a new, empty session with no current-work context. Requires delegate permission. Linked CLI: use ask_agent.',
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
    permission: 'delegate',
    /** The task text, and any `context_files` content read into it, goes to
     *  another model — a local engine, a cloud provider or a CLI agent with its
     *  own tools. `untrustedExitPolicy.ts` cards that in a chat holding outside
     *  content or a secret, and lets it run with no card in a clean chat. */
    reachesOut: 'delegation',
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
      if (isCliTarget(getConfig(), requested))
        return { detail: 'Use ask_agent for linked CLI sessions.' };
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
      const requested = args['model'];
      if (typeof requested === 'string' && isCliTarget(config, requested))
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

/** Resolve aliases, short names and profiles before enforcing the CLI boundary. */
function isCliTarget(config: ForgeConfig, requested: string): boolean {
  try {
    return resolveDelegationTarget(config, requested).provider === 'cli';
  } catch {
    return false;
  }
}
