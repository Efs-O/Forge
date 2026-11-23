import { z } from 'zod';

/**
 * Primitive Zod building blocks shared between the top-level config schema
 * and the `groups` ("boards") schema — split out of schema.ts to stay under
 * the 350-LOC file limit. See docs/OWNERS.md.
 */

export const CacheTypeSchema = z.union([z.number().int().min(0).max(8), z.string().min(1)]);

export const ReasoningEffortSchema = z.enum(['xhigh', 'high', 'medium', 'low', 'none']);
/** How a model's own text may be read as a tool call; see ModelConfig. */
export const TextToolCallModeSchema = z.enum(['auto', 'text', 'native']);

export const SamplingSchema = z.object({
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().optional(),
  min_p: z.number().optional(),
  max_tokens: z.number().int().optional(),
  seed: z.number().int().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  repetition_penalty: z.number().optional(),
  repeat_penalty: z.number().optional(),
  repeat_last_n: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  preserve_thinking: z.boolean().optional(),
});

export const CapabilitiesSchema = z.array(z.enum(['tool-call', 'vision', 'long-context']));

/** What a config that still names the removed `xai` provider is told, and why
 *  Forge will not rewrite the entry itself: `openai-compatible` carries
 *  Strata-specific defaults, so it is a decision for the user to make. */
export const XAI_REMOVED_MESSAGE =
  'provider "xai" was removed in Forge 0.17.207. To keep using Grok, set provider: openai-compatible, endpoint: https://api.x.ai/v1 and api_key_secret (store the key with "Forge: Set Cloud Provider Token"), or delete the entry.';

/** A bad enum value keeps zod's own message, except the one provider this
 *  release removed: that one names the replacement. */
const providerEnumError = (iss: { input: unknown }): string | undefined =>
  iss.input === 'xai' ? XAI_REMOVED_MESSAGE : undefined;

export const ProviderSchema = z.enum(
  ['llama.cpp', 'ollama', 'openrouter', 'openai', 'openai-compatible', 'cli'],
  { error: providerEnumError },
);

export const ToolCallLimitsSchema = z.record(z.string().min(1), z.number().int().min(0));

export const ToolGroupsSchema = z.object({
  eager: z.array(z.string().min(1)).default([]),
  /** Keep the tool list fixed for the whole chat: `load_tool_group` returns the
   *  group's schemas in its result and the model calls those tools as text.
   *  Cannot be combined with `text_tool_calls: native`. */
  schemas_in_result: z.boolean().optional(),
});

// Spawn-time facts (F6). All optional — present-block overrides flat fields.
export const SpawnSchema = z.object({
  num_ctx: z.number().int().positive().optional(),
  n_parallel: z.number().int().positive().optional(),
  n_batch: z.number().int().positive().optional(),
  type_k: CacheTypeSchema.optional(),
  type_v: CacheTypeSchema.optional(),
  flash_attn: z.boolean().optional(),
  n_gpu_layers: z.number().int().optional(),
  extra_llama_server_args: z.array(z.string()).optional(),
});

// Shared config bundle ("board") — F7. All optional; a model opts in via
// `group`/`groups`. See docs/plans/CONFIG_OVERHAUL_PLAN.md §2.1.
export const GroupSchema = z.object({
  provider: ProviderSchema.optional(),
  token_count: z.enum(['tokenize', 'count_tokens', 'estimate']).optional(),
  endpoint: z.string().url().optional(),
  spawn: SpawnSchema.optional(),
  sampling: SamplingSchema.optional(),
  num_ctx: z.number().int().positive().optional(),
  think: z.boolean().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  thinking_off_effort: ReasoningEffortSchema.optional(),
  strip_tools: z.boolean().optional(),
  strip_thinking_channels: z.boolean().optional(),
  system_prompt: z.string().optional(),
  system_prompt_mode: z.enum(['append', 'replace']).optional(),
  capabilities: CapabilitiesSchema.optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_tool_rounds: z.number().int().positive().optional(),
  text_tool_calls: TextToolCallModeSchema.optional(),
  tool_groups: ToolGroupsSchema.optional(),
  tools: z.array(z.string().min(1)).optional(),
  tool_call_limits: ToolCallLimitsSchema.optional(),
});
