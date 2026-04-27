import { z } from 'zod';

const ModelConfigSchema = z.object({
  name: z.string().min(1),
  gguf_path: z.string().min(1),
  n_gpu_layers: z.number().int().optional(),
  num_ctx: z.number().int().positive().optional(),
  n_batch: z.number().int().positive().optional(),
  type_k: z.number().int().min(0).max(8).optional(),
  type_v: z.number().int().min(0).max(8).optional(),
  flash_attn: z.boolean().optional(),
  extra_llama_server_args: z.array(z.string()).optional(),
  // v0.3 additions
  sampling: z.object({
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().int().optional(),
    min_p: z.number().optional(),
    max_tokens: z.number().int().optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    preserve_thinking: z.boolean().optional(),
  }).optional(),
  capabilities: z.array(z.enum(['tool-call', 'vision', 'long-context'])).optional(),
  strip_tools: z.boolean().optional(),
  system_prompt: z.string().optional(),
  think: z.boolean().optional(),
});

const LlamaServerConfigSchema = z.object({
  binary: z.string().min(1).optional(),
  n_gpu_layers: z.number().int().optional(),
  default_num_ctx: z.number().int().positive().optional(),
  n_batch: z.number().int().positive().optional(),
  n_parallel: z.number().int().positive().optional(),
  type_k: z.number().int().min(0).max(8).optional(),
  type_v: z.number().int().min(0).max(8).optional(),
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
  models: z.array(ModelConfigSchema).min(1, 'At least one model is required'),
  active_model: z.string().min(1),
  llama_server: LlamaServerConfigSchema,
  bridge_mode: z.boolean().optional(),
  search: SearchConfigSchema.optional(),
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional(),
  // v0.3 additions
  model_dirs: z.array(z.string()).optional(),
  templates_dir: z.string().optional(),
  custom_instructions: z.string().optional(),
  permissions: PermissionsSchema,
  exec: ExecConfigSchema,
}).superRefine((cfg, ctx) => {
  const names = cfg.models.map((m) => m.name);
  if (!names.includes(cfg.active_model)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['active_model'],
      message: `active_model "${cfg.active_model}" does not match any entry in models (${names.join(', ')})`,
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
