import { z } from 'zod';
import {
  CacheTypeSchema,
  CapabilitiesSchema,
  GroupSchema,
  ProviderSchema,
  ReasoningEffortSchema,
  SamplingSchema,
  SpawnSchema,
  ToolCallLimitsSchema,
} from './schemaShared';

/**
 * The model-side of the config schema: the active-model preprocessor, the
 * request-time role preset (F6), the per-model config, and the group-field
 * resolution the top-level refinement uses. Kept apart from schema.ts so the
 * model shape and the top-level assembly each have one home.
 */

export const ActiveModelSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && value.trim().toLowerCase() === 'none') return null;
    return value;
  },
  z.union([z.string().min(1), z.null()]),
);

// Request-time role preset (F6).
export const ProfileSchema = z.object({
  system_prompt: z.string().optional(),
  // 'replace' sends system_prompt INSTEAD of the Forge template. Default
  // 'append' keeps the template and adds system_prompt beneath it.
  system_prompt_mode: z.enum(['append', 'replace']).optional(),
  sampling: SamplingSchema.optional(),
  think: z.boolean().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  strip_tools: z.boolean().optional(),
  strip_thinking_channels: z.boolean().optional(),
  capabilities: CapabilitiesSchema.optional(),
  max_tool_rounds: z.number().int().positive().optional(),
});

export const ModelConfigSchema = z.object({
  name: z.string().min(1),
  provider: ProviderSchema.optional(),
  cli: z.string().min(1).optional(),
  cli_model: z.string().min(1).optional(),
  gguf_path: z.string().min(1).optional(),
  mmproj_path: z.string().min(1).optional(),
  // Per-model llama-server executable override (e.g. a patched fork for one
  // model). Absent = the global llama_server.binary. See ModelConfig.
  llama_server_binary: z.string().min(1).optional(),
  startup_timeout_ms: z.number().int().min(1_000).optional(),
  // Log file of a server Forge does not spawn (e.g. Strata), mirrored into an
  // output channel. See src/backend/serverLogFollower.ts.
  server_log: z.string().min(1).optional(),
  // POSTed against `endpoint` to free a local openai-compatible server's memory
  // (Strata). See src/backend/ExternalModelServers.ts.
  unload_path: z
    .string()
    .regex(/^\/\S*$/, 'unload_path must be an absolute path such as /unload')
    .optional(),
  // Opt-in process stop for a managed external server. argv only: never a
  // shell command string, and never interpreted by Forge.
  stop_on_exit: z.boolean().optional(),
  stop_command: z
    .array(
      z
        .string()
        .refine((value) => value.trim().length > 0, 'stop_command entries must not be empty'),
    )
    .min(1)
    .optional(),
  // Executable plus argv launched (detached) before a request when the managed
  // server is down. argv only: never a shell command string, never interpreted.
  start_command: z
    .array(
      z
        .string()
        .refine((value) => value.trim().length > 0, 'start_command entries must not be empty'),
    )
    .min(1)
    .optional(),
  // Omitted = disabled. No implicit default, and YAML `null` is rejected rather
  // than silently meaning "off" — opting in is explicit.
  image_retention_turns: z.number().int().nonnegative().optional(),
  endpoint: z.string().url().optional(),
  n_gpu_layers: z.number().int().optional(),
  num_ctx: z.number().int().positive().optional(),
  n_batch: z.number().int().positive().optional(),
  type_k: CacheTypeSchema.optional(),
  type_v: CacheTypeSchema.optional(),
  flash_attn: z.boolean().optional(),
  extra_llama_server_args: z.array(z.string()).optional(),
  n_parallel: z.number().int().positive().optional(),
  // v0.3 additions
  sampling: SamplingSchema.optional(),
  capabilities: CapabilitiesSchema.optional(),
  strip_tools: z.boolean().optional(),
  system_prompt: z.string().optional(),
  system_prompt_mode: z.enum(['append', 'replace']).optional(),
  think: z.boolean().optional(),
  chat_template_thinking: z.boolean().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  strip_thinking_channels: z.boolean().optional(),
  api_key_secret: z.string().min(1).optional(),
  // F6 additions
  /** Request-time profiles exposed for this model; [] disables them. */
  profiles: z.array(z.string().min(1)).optional(),
  spawn: SpawnSchema.optional(),
  spawn_profiles: z.record(z.string(), SpawnSchema.partial()).optional(),
  // F7 additions (groups + fuzzy resolution + model manager identity fields)
  group: z.string().min(1).optional(),
  groups: z.array(z.string().min(1)).optional(),
  short_name: z.string().min(1).optional(),
  display_name: z.string().trim().min(1).max(60).optional(),
  category: z.string().min(1).optional(),
  comment: z.string().optional(),
  tools: z.array(z.string().min(1)).optional(),
  tool_call_limits: ToolCallLimitsSchema.optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_tool_rounds: z.number().int().positive().optional(),
});

// Provider-requiredness checks (gguf_path/cli/endpoint/api_key_secret) live at
// the top-level ForgeConfigSchema refine (see below), not here — `provider`
// and `endpoint` are both fields a model may inherit from a referenced
// `group` (F7 §2.1), and a per-model refine has no visibility into `groups`.
// gguf_path/cli/api_key_secret are never group-suppliable (GroupSchema omits
// them), so they still resolve purely from the model itself.
type ModelConfigLike = z.infer<typeof ModelConfigSchema>;

/** Last group in the model's `group`/`groups` list that defines `field`
 *  wins — matches ConfigResolver.mergeGroupsIntoModel's merge order. */
export function effectiveGroupField<K extends 'provider' | 'endpoint'>(
  model: ModelConfigLike,
  groups: Record<string, z.infer<typeof GroupSchema>> | undefined,
  field: K,
): ModelConfigLike[K] | undefined {
  const names = model.groups ?? (model.group ? [model.group] : []);
  let value: ModelConfigLike[K] | undefined;
  for (const name of names) {
    const group = groups?.[name];
    const fieldValue = group?.[field];
    if (fieldValue !== undefined) value = fieldValue as ModelConfigLike[K];
  }
  return value;
}
