export interface ModelConfig {
  /** Display name shown in the sidebar model picker. */
  name: string;
  /** Absolute path to the .gguf file. */
  gguf_path: string;
  /** Per-model GPU layer override. Falls back to LlamaServerConfig.n_gpu_layers. */
  n_gpu_layers?: number;
  /** Context window size override. Falls back to LlamaServerConfig.default_num_ctx. */
  num_ctx?: number;
  /** Batch size override. Falls back to LlamaServerConfig.n_batch. */
  n_batch?: number;
  /** KV-cache quantization for K tensors (0=f32, 1=f16, 8=q8_0). */
  type_k?: number;
  /** KV-cache quantization for V tensors. */
  type_v?: number;
  /** Flash attention override. Falls back to LlamaServerConfig.flash_attn_default. */
  flash_attn?: boolean;
  /** Extra argv tokens appended verbatim after all computed args. */
  extra_llama_server_args?: string[];
  /** Per-model sampling parameter overrides. */
  sampling?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    max_tokens?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    preserve_thinking?: boolean;
  };
  /** Model capability hints used for tool-call routing and UI. */
  capabilities?: ('tool-call' | 'vision' | 'long-context')[];
  /** When true, strip tool definitions from the request for this model. */
  strip_tools?: boolean;
  /** Per-model system prompt override (takes precedence over template). */
  system_prompt?: string;
  /** When true, enable thinking/reasoning tokens for this model. */
  think?: boolean;
}

export interface LlamaServerConfig {
  /** Path to the llama-server binary. Required unless bridge_mode is true. */
  binary?: string;
  /** Default GPU layers when the model doesn't override. -1 = all. */
  n_gpu_layers?: number;
  /** Default context size when the model doesn't override. */
  default_num_ctx?: number;
  /** Batch size default. */
  n_batch?: number;
  /** Number of parallel request slots. */
  n_parallel?: number;
  /** KV-cache K quantization default. */
  type_k?: number;
  /** KV-cache V quantization default. */
  type_v?: number;
  /** Flash attention default. */
  flash_attn_default?: boolean;
  /** CPU thread count (0 = auto). */
  n_threads?: number;
  /** CPU thread count for batch processing. */
  n_threads_batch?: number;
  /** Host to bind llama-server. Defaults to 127.0.0.1. */
  host?: string;
  /** Port to bind llama-server. Defaults to 8080. */
  port?: number;
}

export interface SearchConfig {
  provider: 'tavily' | 'brave';
  /** Secret key name in VS Code SecretStorage — never a raw key. */
  secret_key_name: string;
  max_results?: number;
}

export interface ForgeConfig {
  models: ModelConfig[];
  active_model: string;
  llama_server: LlamaServerConfig;
  /** When true, connect to a pre-running server instead of spawning llama-server. */
  bridge_mode?: boolean;
  search?: SearchConfig;
  log_level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** Extra directories to scan for GGUF files (used by first-run wizard). */
  model_dirs?: string[];
  /** Path to a directory containing user-defined Nunjucks template overrides. */
  templates_dir?: string;
  /** Text injected into every system prompt via the template engine. */
  custom_instructions?: string;
  /** Tool permission gates. Defaults to read-only fs, no net/exec/git-write. */
  permissions?: {
    fs?: { read?: boolean; write?: boolean; delete?: boolean };
    net?: { search?: boolean; fetch?: boolean };
    exec?: { terminal?: boolean; headless?: boolean };
    git?: { read?: boolean; write?: boolean };
  };
  /** Execution sandbox settings. */
  exec?: {
    timeout_ms?: number;
    denylist_extra?: string[];
  };
}
