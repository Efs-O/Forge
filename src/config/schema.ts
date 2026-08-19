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

const ToolPermissionSchema = z.enum(
  [
    'read',
    'write',
    'delete',
    'terminal',
    'headless',
    'search',
    'fetch',
    'git-read',
    'git-write',
    'delegate',
    'cloud-worker',
  ],
  {
    error:
      'MCP tool permission must be one of: read, write, delete, terminal, headless, search, fetch, git-read, git-write, delegate, cloud-worker',
  },
);
const ActiveModelSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && value.trim().toLowerCase() === 'none') return null;
    return value;
  },
  z.union([z.string().min(1), z.null()]),
);

// Request-time role preset (F6).
const ProfileSchema = z.object({
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
});

const ModelConfigSchema = z.object({
  name: z.string().min(1),
  provider: ProviderSchema.optional(),
  cli: z.string().min(1).optional(),
  cli_model: z.string().min(1).optional(),
  gguf_path: z.string().min(1).optional(),
  mmproj_path: z.string().min(1).optional(),
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
  reasoning_effort: ReasoningEffortSchema.optional(),
  strip_thinking_channels: z.boolean().optional(),
  api_key_secret: z.string().min(1).optional(),
  // F6 additions
  spawn: SpawnSchema.optional(),
  spawn_profiles: z.record(z.string(), SpawnSchema.partial()).optional(),
  // F7 additions (groups + fuzzy resolution + model manager identity fields)
  group: z.string().min(1).optional(),
  groups: z.array(z.string().min(1)).optional(),
  short_name: z.string().min(1).optional(),
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
function effectiveGroupField<K extends 'provider' | 'endpoint'>(
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

const LlamaServerConfigSchema = z.object({
  binary: z.string().min(1).optional(),
  n_gpu_layers: z.number().int().optional(),
  default_num_ctx: z.number().int().positive().optional(),
  n_batch: z.number().int().positive().optional(),
  n_parallel: z.number().int().positive().optional(),
  type_k: CacheTypeSchema.optional(),
  type_v: CacheTypeSchema.optional(),
  flash_attn_default: z.boolean().optional(),
  n_threads: z.number().int().min(0).optional(),
  n_threads_batch: z.number().int().min(0).optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

const SharedRuntimeSchema = z.object({ enabled: z.boolean() }).optional();

const SearchConfigSchema = z.object({
  provider: z.enum(['tavily', 'brave']),
  secret_key_name: z.string().min(1),
  max_results: z.number().int().positive().optional(),
});

const EmbeddingsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    model_path: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    // Embedding model's context window. Also pins --batch-size/--ubatch-size,
    // which must be >= the largest chunk or llama.cpp rejects it (HTTP 500).
    n_ctx: z.number().int().positive().optional(),
    // Task prefixes applied to documents and queries. `gemma` is correct for
    // EmbeddingGemma only — it would corrupt nomic-embed/bge results. Changing
    // this invalidates the stored index and forces a rebuild.
    prompt_style: z.enum(['gemma', 'none']).optional(),
    auto_index_on_search: z.boolean().optional(),
    max_file_size_kb: z.number().int().positive().optional(),
    include_globs: z.array(z.string().min(1)).optional(),
    exclude_globs: z.array(z.string().min(1)).optional(),
  })
  .optional();

const PermissionsSchema = z
  .object({
    fs: z
      .object({
        read: z.boolean().default(true),
        write: z.boolean().default(true),
        delete: z.boolean().default(false),
      })
      .optional(),
    net: z
      .object({
        search: z.boolean().default(false),
        fetch: z.boolean().default(false),
      })
      .optional(),
    exec: z
      .object({
        terminal: z.boolean().default(false),
        headless: z.boolean().default(false),
      })
      .optional(),
    git: z
      .object({
        read: z.boolean().default(true),
        write: z.boolean().default(false),
      })
      .optional(),
    agents: z
      .object({
        delegate: z.boolean().default(false),
        cloud_workers: z.boolean().default(false),
      })
      .optional(),
  })
  .optional();

const ExecConfigSchema = z
  .object({
    timeout_ms: z.number().int().positive().default(30000),
    denylist_extra: z.array(z.string()).optional(),
  })
  .optional();

export const ForgeConfigSchema = z
  .object({
    models: z.array(ModelConfigSchema).default([]),
    active_model: ActiveModelSchema.default(null),
    // F7 addition
    groups: z.record(z.string(), GroupSchema).optional(),
    // F6 additions
    defaults: ProfileSchema.partial().optional(),
    profiles: z.record(z.string(), ProfileSchema).optional(),
    aliases: z.record(z.string(), z.string().min(1)).optional(),
    llama_server: LlamaServerConfigSchema.default({}),
    shared_runtime: SharedRuntimeSchema,
    search: SearchConfigSchema.optional(),
    embeddings: EmbeddingsConfigSchema,
    log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional(),
    // v0.3 additions
    model_dirs: z.array(z.string()).optional(),
    templates_dir: z.string().optional(),
    custom_instructions: z.string().optional(),
    strip_thinking_channels: z.boolean().optional(),
    max_simultaneous_models: z.number().int().min(1).max(8).optional(),
    max_cli_agents: z.number().int().min(1).max(32).optional(),
    cli_idle_timeout_ms: z.number().int().min(1000).optional(),
    ollama: z
      .object({
        auto_start: z.boolean().optional(),
        executable: z.string().min(1).optional(),
      })
      .optional(),
    auto_compact: z
      .object({
        enabled: z.boolean().optional(),
        // Upper bound below 1: the summarization call still needs context to run.
        at: z.number().min(0.5).max(0.95).optional(),
        resume: z.boolean().optional(),
      })
      .optional(),
    control_server: z
      .object({
        enabled: z.boolean().optional(),
        port: z.number().int().min(1).max(65535).optional(),
      })
      .optional(),
    permissions: PermissionsSchema,
    exec: ExecConfigSchema,
    mcp_servers: z
      .array(
        z.object({
          name: z.string().min(1),
          command: z.string().min(1),
          args: z.array(z.string()).optional(),
          max_result_chars: z.number().int().positive().optional(),
          tool_permissions: z.record(z.string(), ToolPermissionSchema).optional(),
        }),
      )
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.models.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models'],
        message: 'At least one model is required',
      });
    }
    cfg.models.forEach((model, index) => {
      const provider =
        model.provider ?? effectiveGroupField(model, cfg.groups, 'provider') ?? 'llama.cpp';
      const endpoint = model.endpoint ?? effectiveGroupField(model, cfg.groups, 'endpoint');
      if (provider === 'llama.cpp' && !model.gguf_path) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', index, 'gguf_path'],
          message: 'gguf_path is required for provider: llama.cpp',
        });
      }
      if (provider === 'cli' && !model.cli) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', index, 'cli'],
          message: 'cli is required for provider: cli',
        });
      }
      if ((provider === 'ollama' || provider === 'openai-compatible') && !endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', index, 'endpoint'],
          message: `endpoint is required for provider: ${provider} (directly, or via a referenced group)`,
        });
      }
      if (
        (provider === 'xai' ||
          provider === 'openrouter' ||
          provider === 'openai' ||
          provider === 'openai-compatible') &&
        !model.api_key_secret
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', index, 'api_key_secret'],
          message: `api_key_secret is required for provider: ${provider}`,
        });
      }
    });
    const hasLocalModel = cfg.models.some(
      (m) =>
        (m.provider ?? effectiveGroupField(m, cfg.groups, 'provider') ?? 'llama.cpp') ===
        'llama.cpp',
    );
    if (hasLocalModel && !cfg.llama_server.binary) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llama_server', 'binary'],
        message: 'llama_server.binary is required when any model uses provider: llama.cpp',
      });
    }
    if (cfg.embeddings?.enabled && !cfg.embeddings.model_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['embeddings', 'model_path'],
        message: 'embeddings.model_path is required when embeddings.enabled: true',
      });
    }
    if (cfg.embeddings?.enabled && !cfg.llama_server.binary) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llama_server', 'binary'],
        message: 'llama_server.binary is required when embeddings.enabled: true',
      });
    }
  });

export type ForgeConfigInput = z.input<typeof ForgeConfigSchema>;
