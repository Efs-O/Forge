import { z } from 'zod';

const CacheTypeSchema = z.union([
  z.number().int().min(0).max(8),
  z.string().min(1),
]);

const ReasoningEffortSchema = z.enum(['high', 'medium', 'low', 'none']);
const ActiveModelSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'none') return null;
  return value;
}, z.union([z.string().min(1), z.null()]));

const ModelConfigSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(['llama.cpp', 'ollama']).optional(),
  gguf_path: z.string().min(1).optional(),
  endpoint: z.string().url().optional(),
  n_gpu_layers: z.number().int().optional(),
  num_ctx: z.number().int().positive().optional(),
  n_batch: z.number().int().positive().optional(),
  type_k: CacheTypeSchema.optional(),
  type_v: CacheTypeSchema.optional(),
  flash_attn: z.boolean().optional(),
  extra_llama_server_args: z.array(z.string()).optional(),
  // v0.3 additions
  sampling: z.object({
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
  }).optional(),
  capabilities: z.array(z.enum(['tool-call', 'vision', 'long-context'])).optional(),
  strip_tools: z.boolean().optional(),
  system_prompt: z.string().optional(),
  think: z.boolean().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  strip_thinking_channels: z.boolean().optional(),
}).superRefine((model, ctx) => {
  const provider = model.provider ?? 'llama.cpp';
  if (provider === 'llama.cpp' && !model.gguf_path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gguf_path'],
      message: 'gguf_path is required for provider: llama.cpp',
    });
  }
  if (provider === 'ollama' && !model.endpoint) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endpoint'],
      message: 'endpoint is required for provider: ollama',
    });
  }
});

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

const SearchConfigSchema = z.object({
  provider: z.enum(['tavily', 'brave']),
  secret_key_name: z.string().min(1),
  max_results: z.number().int().positive().optional(),
});

const PermissionsSchema = z.object({
  fs: z.object({
    read: z.boolean().default(true),
    write: z.boolean().default(true),
    delete: z.boolean().default(false),
  }).optional(),
  net: z.object({
    search: z.boolean().default(false),
    fetch: z.boolean().default(false),
  }).optional(),
  exec: z.object({
    terminal: z.boolean().default(false),
    headless: z.boolean().default(false),
  }).optional(),
  git: z.object({
    read: z.boolean().default(true),
    write: z.boolean().default(false),
  }).optional(),
}).optional();

const ExecConfigSchema = z.object({
  timeout_ms: z.number().int().positive().default(30000),
  denylist_extra: z.array(z.string()).optional(),
}).optional();

export const ForgeConfigSchema = z.object({
  models: z.array(ModelConfigSchema).default([]),
  active_model: ActiveModelSchema.default(null),
  bridge_config: z.string().min(1).optional(),
  llama_server: LlamaServerConfigSchema.default({}),
  bridge_mode: z.boolean().optional(),
  search: SearchConfigSchema.optional(),
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional(),
  // v0.3 additions
  model_dirs: z.array(z.string()).optional(),
  templates_dir: z.string().optional(),
  custom_instructions: z.string().optional(),
  strip_thinking_channels: z.boolean().optional(),
  max_simultaneous_models: z.number().int().min(1).max(8).optional(),
  permissions: PermissionsSchema,
  exec: ExecConfigSchema,
}).superRefine((cfg, ctx) => {
  if (cfg.models.length === 0 && !cfg.bridge_config) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['models'],
      message: 'At least one model is required unless bridge_config is provided',
    });
  }
  if (!cfg.bridge_mode && !cfg.llama_server.binary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['llama_server', 'binary'],
      message: 'llama_server.binary is required unless bridge_mode: true',
    });
  }
});

export type ForgeConfigInput = z.input<typeof ForgeConfigSchema>;
