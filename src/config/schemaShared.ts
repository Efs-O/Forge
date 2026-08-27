import { z } from 'zod';

/**
 * Primitive Zod building blocks shared between the top-level config schema
 * and the `groups` ("boards") schema — split out of schema.ts to stay under
 * the 350-LOC file limit. See docs/OWNERS.md.
 */

export const CacheTypeSchema = z.union([z.number().int().min(0).max(8), z.string().min(1)]);

export const ReasoningEffortSchema = z.enum(['high', 'medium', 'low', 'none']);

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

export const ProviderSchema = z.enum([
  'llama.cpp',
  'ollama',
  'xai',
  'openrouter',
  'openai',
  'openai-compatible',
  'cli',
]);

export const ToolCallLimitsSchema = z.record(z.string().min(1), z.number().int().min(0));

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
  endpoint: z.string().url().optional(),
  spawn: SpawnSchema.optional(),
  sampling: SamplingSchema.optional(),
  num_ctx: z.number().int().positive().optional(),
  think: z.boolean().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  strip_tools: z.boolean().optional(),
  strip_thinking_channels: z.boolean().optional(),
  system_prompt: z.string().optional(),
  system_prompt_mode: z.enum(['append', 'replace']).optional(),
  capabilities: CapabilitiesSchema.optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_tool_rounds: z.number().int().positive().optional(),
  tools: z.array(z.string().min(1)).optional(),
  tool_call_limits: ToolCallLimitsSchema.optional(),
});
