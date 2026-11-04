import { z } from 'zod';
import { isAbsolute } from 'path';
import { CacheTypeSchema, GroupSchema } from './schemaShared';
import { VoiceConfigSchema, validateVoiceConfig } from './voiceSchema';
import { ImageGenerationConfigSchema } from './imageGenerationSchema';
import { MediaConfigSchema } from './mediaSchema';
import { JobsConfigSchema } from './jobsSchema';
import { ModelStarterConfigSchema, validateModelStarterConfig } from './modelStarterSchema';
import { EnginesSchema, ModelHostsSchema } from './engineSchema';
import { CloudRelayConfigSchema, validateCloudRelayConfig } from './cloudRelaySchema';
import type { ForgeConfig } from './types';
import { AgentBusConfigSchema, AgentLinksConfigSchema } from './agentBusSchema';
import { ImageSearchConfigSchema } from './imageSearchSchema';
import { FetchConfigSchema } from './fetchSchema';
import { BrowserConfigSchema } from './browserSchema';
import { PermissionsSchema } from './permissionsSchema';
import {
  ActiveModelSchema,
  ProfileSchema,
  ModelConfigSchema,
  effectiveGroupField,
  validateRemoteStartEntry,
} from './modelSchema';
import { RemoteConfigSchema } from './remoteSchema';
import { ToolsConfigSchema, SkillsConfigSchema } from './toolsSchema';
import { NATIVE_LAZY_GROUP_NAMES } from './toolGroupNames';
import { ToolGroupsSchema } from './schemaShared';

export { CloudRelayConfigSchema } from './cloudRelaySchema';

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
  ],
  {
    error:
      'MCP tool permission must be one of: read, write, delete, terminal, headless, search, fetch, git-read, git-write, delegate',
  },
);
/** `control_server.port` when the block names none; mirrors ControlServer's DEFAULT_PORT. */
const DEFAULT_CONTROL_SERVER_PORT = 8799;

const LlamaServerConfigSchema = z.object({
  binary: z.string().min(1).optional(),
  extra_llama_server_args: z.array(z.string()).optional(),
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
  provider: z.enum(['duckduckgo', 'tavily', 'brave']),
  fallback: z.enum(['tavily', 'brave']).optional(),
  secret_key_name: z.string().min(1).optional(),
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
    // llama.cpp `--device` value: `CUDA2`, or `none` for CPU only. Absent means
    // llama.cpp's default, which spreads over every visible GPU.
    device: z
      .string()
      .regex(/^[A-Za-z0-9_]+(,[A-Za-z0-9_]+)*$/)
      .optional(),
    // Task prefixes applied to documents and queries. `gemma` is correct for
    // EmbeddingGemma only — it would corrupt nomic-embed/bge results. Changing
    // this invalidates the stored index and forces a rebuild.
    prompt_style: z.enum(['gemma', 'none']).optional(),
    auto_index_on_search: z.boolean().optional(),
    confirm_on_start: z.boolean().optional(),
    idle_timeout_ms: z.number().int().positive().optional(),
    max_file_size_kb: z.number().int().positive().optional(),
    include_globs: z.array(z.string().min(1)).optional(),
    exclude_globs: z.array(z.string().min(1)).optional(),
  })
  .optional();

/**
 * `view_video` frame extraction. `frame_max_dimension` is the context knob, not
 * a quality one: measured on a 5 s clip against Qwen3.8-27B, unscaled 1920x1088
 * costs 22,501 prompt tokens (rejected at 16k ctx), 640 px costs 2,479, and
 * 384 px costs 983.
 */
const VideoConfigSchema = z
  .object({
    max_duration_seconds: z.number().positive().optional(),
    max_frames: z.number().int().positive().max(64).optional(),
    frame_max_dimension: z.number().int().min(64).max(4096).optional(),
    // ffmpeg -q:v: 2 is best quality, higher is smaller.
    frame_quality: z.number().int().min(2).max(31).optional(),
    ffmpeg_path: z.string().optional(),
  })
  .optional();

const ExecConfigSchema = z
  .object({
    timeout_ms: z.number().int().positive().default(30000),
    denylist_extra: z.array(z.string()).optional(),
  })
  .optional();

/** Owner-edited approval policy. There are deliberately no defaults here: an
 *  absent allow list grants nothing, and `approval_timeout_minutes` remains a
 *  separate owner-set permission. */
const ApprovalAllowListSchema = z
  .object({
    allow: z.array(z.string().min(1)),
  })
  .strict();

const ApprovalsConfigSchema = z
  .object({
    always: z
      .array(
        z
          .object({
            key: z.string().min(1),
            workspace: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    jobs: z.record(z.string().min(1), ApprovalAllowListSchema).optional(),
    unattended_bus: ApprovalAllowListSchema.optional(),
  })
  .strict()
  .optional();

/** The top-level shape, kept as a value so `policySchema.ts` can pick the blocks
 *  that belong in `~/.forge/policy.yaml` without restating any of them. */
export const ForgeConfigShape = {
  models: z.array(ModelConfigSchema).default([]),
  active_model: ActiveModelSchema.default(null),
  // F7 addition
  groups: z.record(z.string(), GroupSchema).optional(),
  // F6 additions
  defaults: ProfileSchema.partial().extend({ tool_groups: ToolGroupsSchema.optional() }).optional(),
  profiles: z.record(z.string(), ProfileSchema).optional(),
  aliases: z.record(z.string(), z.string().min(1)).optional(),
  llama_server: LlamaServerConfigSchema.default({}),
  shared_runtime: SharedRuntimeSchema,
  search: SearchConfigSchema.optional(),
  embeddings: EmbeddingsConfigSchema,
  video: VideoConfigSchema,
  voice: VoiceConfigSchema,
  image_generation: ImageGenerationConfigSchema,
  media: MediaConfigSchema.optional(),
  jobs: JobsConfigSchema,
  model_starter: ModelStarterConfigSchema,
  cloud_relay: CloudRelayConfigSchema,
  agent_bus: AgentBusConfigSchema,
  agent_links: AgentLinksConfigSchema.default({
    open_panel: 'every_ask',
    panel_live_timeout_ms: 20_000,
  }),
  image_search: ImageSearchConfigSchema,
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional(),
  // v0.3 additions
  model_dirs: z.array(z.string()).optional(),
  extra_file_roots: z.array(z.string().refine(isAbsolute, 'must be an absolute path')).optional(),
  templates_dir: z.string().optional(),
  custom_instructions: z.string().optional(),
  forge_instructions: z
    .object({
      auto_create: z.boolean().optional(),
    })
    .optional(),
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
  // Absent block = off: no hidden default, the note only matters for long tasks.
  // The floor of 5 keeps a "nag every minute" setting impossible.
  elapsed_time_note: z
    .object({
      after_minutes: z.number().int().min(5).max(240),
    })
    .optional(),
  record_requests: z
    .object({
      enabled: z.boolean(),
      max_mb: z.number().int().min(1).max(10_000),
      keep_hours: z.number().int().min(1).max(720),
    })
    .optional(),
  control_server: z
    .object({
      enabled: z.boolean().optional(),
      port: z.number().int().min(1).max(65535).optional(),
    })
    .optional(),
  remote: RemoteConfigSchema,
  permissions: PermissionsSchema,
  approvals: ApprovalsConfigSchema,
  browser: BrowserConfigSchema,
  fetch: FetchConfigSchema,
  exec: ExecConfigSchema,
  /** Tool-layer settings; absent means every tool behaves as it always has. */
  tools: ToolsConfigSchema,
  /**
   * Skills: instruction folders the model can open with `load_skill`. Absent
   * means off — no catalog in the prompt and no `load_skill` schema, so a
   * workspace that has none pays nothing for the feature (`toolsSchema.ts`).
   */
  skills: SkillsConfigSchema,
  engines: EnginesSchema,
  model_hosts: ModelHostsSchema,
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
};

export const ForgeConfigSchema = z.object(ForgeConfigShape).superRefine((cfg, ctx) => {
  const validGroups = NATIVE_LAZY_GROUP_NAMES.join(', ');
  const validateEagerGroups = (
    value: { eager: string[] } | undefined,
    path: (string | number)[],
  ) => {
    for (const [index, group] of (value?.eager ?? []).entries()) {
      if ((NATIVE_LAZY_GROUP_NAMES as readonly string[]).includes(group)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'eager', index],
        message: `Unknown native tool group "${group}". Valid groups: ${validGroups}`,
      });
    }
  };
  validateEagerGroups(cfg.defaults?.tool_groups, ['defaults', 'tool_groups']);
  for (const [name, group] of Object.entries(cfg.groups ?? {})) {
    validateEagerGroups(group.tool_groups, ['groups', name, 'tool_groups']);
  }
  cfg.models.forEach((model, index) =>
    validateEagerGroups(model.tool_groups, ['models', index, 'tool_groups']),
  );
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
    const tokenCount = model.token_count ?? effectiveGroupField(model, cfg.groups, 'token_count');
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
    if (
      tokenCount &&
      provider === 'llama.cpp' &&
      tokenCount !== 'tokenize' &&
      tokenCount !== 'estimate'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'token_count'],
        message: 'token_count for provider: llama.cpp must be tokenize or estimate',
      });
    }
    if (
      tokenCount &&
      provider === 'openai-compatible' &&
      tokenCount !== 'tokenize' &&
      tokenCount !== 'count_tokens' &&
      tokenCount !== 'estimate'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'token_count'],
        message:
          'token_count for provider: openai-compatible must be tokenize, count_tokens, or estimate',
      });
    }
    if (
      tokenCount &&
      provider !== 'llama.cpp' &&
      provider !== 'openai-compatible' &&
      tokenCount !== 'estimate'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'token_count'],
        message: `token_count for provider: ${provider} must be estimate`,
      });
    }
    if ((provider === 'ollama' || provider === 'openai-compatible') && !endpoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'endpoint'],
        message: `endpoint is required for provider: ${provider} (directly, or via a referenced group)`,
      });
    }
    // Since phase 2 a model can inherit these four facts from its `engine` in
    // `~/.forge/policy.yaml`, so a requirement that a field exists has to count
    // the engine's copy: otherwise a migrated Strata — whose `stop_command` and
    // `unload_path` now live in the engine it names — would fail its own schema
    // for a field the engine already supplies. The "only for provider:
    // openai-compatible" refusals below stay keyed to the model's own field, on
    // purpose: a model that names a launcher itself is the one being judged.
    const engine = model.engine ? cfg.engines?.[model.engine] : undefined;
    const hasUnload = model.unload_path !== undefined || engine?.unload_path !== undefined;
    const hasStopCommand = model.stop_command !== undefined || engine?.stop_command !== undefined;
    const hasStartCommand =
      model.start_command !== undefined || engine?.start_command !== undefined;
    if (model.unload_path && provider !== 'openai-compatible') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'unload_path'],
        message: `unload_path is only for provider: openai-compatible (got ${provider})`,
      });
    }
    if (
      (model.stop_on_exit !== undefined || model.stop_command || engine?.stop_command) &&
      provider !== 'openai-compatible'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'stop_on_exit'],
        message: `stop_on_exit and stop_command are only for provider: openai-compatible (got ${provider})`,
      });
    }
    if (model.start_command && provider !== 'openai-compatible') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'start_command'],
        message: `start_command is only for provider: openai-compatible (got ${provider})`,
      });
    }
    if (hasStartCommand && !hasUnload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'start_command'],
        message: 'start_command requires unload_path (a managed server Forge can also start)',
      });
    }
    if (model.stop_on_exit === true && !hasStopCommand) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'stop_command'],
        message: 'stop_command is required when stop_on_exit is true',
      });
    }
    if (model.stop_on_exit === true && !hasUnload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'unload_path'],
        message: 'unload_path is required when stop_on_exit is true',
      });
    }
    // A `remote_start` entry is another machine's server. The refusals live
    // with the field itself, in modelSchema.ts; `provider` and `endpoint` are
    // passed in because either may be inherited from a referenced group.
    validateRemoteStartEntry(model, provider, endpoint, ['models', index], ctx);
    if (
      // openai-compatible may omit it: local servers usually take no key.
      (provider === 'xai' || provider === 'openrouter' || provider === 'openai') &&
      !model.api_key_secret
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', index, 'api_key_secret'],
        message: `api_key_secret is required for provider: ${provider}`,
      });
    }
  });
  // A model carrying its own `llama_server_binary` never reads the global
  // one, so it must not be what forces the global to exist: a config whose
  // only local model points at a patched fork is complete without it. A model
  // that inherits its binary from its engine is in the same position — it runs
  // the engine's program and never looks at the global one either.
  const localModelsNeedingGlobalBinary = cfg.models.filter(
    (m) =>
      (m.provider ?? effectiveGroupField(m, cfg.groups, 'provider') ?? 'llama.cpp') ===
        'llama.cpp' &&
      !(m.llama_server_binary ?? cfg.engines?.[m.engine ?? '']?.llama_server_binary),
  );
  if (localModelsNeedingGlobalBinary.length > 0 && !cfg.llama_server.binary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['llama_server', 'binary'],
      message:
        'llama_server.binary is required when any model uses provider: llama.cpp without its ' +
        'own llama_server_binary',
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
  if (cfg.voice?.keep_model_loaded !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['voice', 'keep_model_loaded'],
      message: 'voice.keep_model_loaded never worked and has been replaced by voice.server.enabled',
    });
  }
  validateVoiceConfig(cfg.voice, ctx);
  validateModelStarterConfig(
    cfg.model_starter,
    cfg.control_server,
    DEFAULT_CONTROL_SERVER_PORT,
    ctx,
  );
  validateCloudRelayConfig(cfg as unknown as ForgeConfig, DEFAULT_CONTROL_SERVER_PORT, ctx);
});
