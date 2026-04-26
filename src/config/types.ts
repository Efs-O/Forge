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
}
