/** Sampling parameter overrides shared by models, profiles, and defaults. */
export interface SamplingConfig {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  max_tokens?: number;
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  repetition_penalty?: number;
  repeat_penalty?: number;
  repeat_last_n?: number;
  stop?: string | string[];
  preserve_thinking?: boolean;
}

/** Spawn-time facts for a llama.cpp model — fed to LlamaServerArgs. */
export interface SpawnConfig {
  num_ctx?: number;
  n_parallel?: number;
  n_batch?: number;
  type_k?: number | string;
  type_v?: number | string;
  flash_attn?: boolean;
  n_gpu_layers?: number;
  extra_llama_server_args?: string[];
}

/** Request-time role preset applied to a base model per request. */
export interface ProfileConfig {
  system_prompt?: string;
  sampling?: SamplingConfig;
  think?: boolean;
  reasoning_effort?: 'high' | 'medium' | 'low' | 'none';
  strip_tools?: boolean;
  strip_thinking_channels?: boolean;
  capabilities?: ('tool-call' | 'vision' | 'long-context')[];
}

export interface ModelConfig {
  /** Display name shown in the sidebar model picker. */
  name: string;
  /** Runtime provider for this model entry. */
  provider?: 'llama.cpp' | 'ollama' | 'xai' | 'openrouter' | 'openai' | 'openai-compatible';
  /** Absolute path to the .gguf file. Required for llama.cpp models. */
  gguf_path?: string;
  /** Optional path to the vision projector .gguf (mmproj). Enables multimodal image input. */
  mmproj_path?: string;
  /** Base URL for Ollama or OpenAI-compatible HTTP providers. */
  endpoint?: string;
  /** Per-model GPU layer override. Falls back to LlamaServerConfig.n_gpu_layers. */
  n_gpu_layers?: number;
  /** Context window size override. Falls back to LlamaServerConfig.default_num_ctx. */
  num_ctx?: number;
  /** Batch size override. Falls back to LlamaServerConfig.n_batch. */
  n_batch?: number;
  /** KV-cache quantization for K tensors (legacy int or llama.cpp string like q8_0). */
  type_k?: number | string;
  /** KV-cache quantization for V tensors (legacy int or llama.cpp string like q8_0). */
  type_v?: number | string;
  /** Flash attention override. Falls back to LlamaServerConfig.flash_attn_default. */
  flash_attn?: boolean;
  /** Extra argv tokens appended verbatim after all computed args. */
  extra_llama_server_args?: string[];
  /** Parallel request slots for this model's llama-server instance (--parallel). Resolved from runtime profile. */
  n_parallel?: number;
  /** Per-model sampling parameter overrides. */
  sampling?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    max_tokens?: number;
    seed?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    repetition_penalty?: number;
    repeat_penalty?: number;
    repeat_last_n?: number;
    stop?: string | string[];
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
  /** Ollama reasoning effort level when think is enabled. */
  reasoning_effort?: 'high' | 'medium' | 'low' | 'none';
  /** When true, strip visible thinking/channel markup when think is explicitly false. */
  strip_thinking_channels?: boolean;
  /** SecretStorage key holding the bearer token for OpenAI-compatible cloud providers (for example xAI, OpenAI, or OpenRouter). */
  api_key_secret?: string;
  /** Spawn-time facts (F6). When present, overrides flat fields at spawn resolution. */
  spawn?: SpawnConfig;
  /** Rare spawn-time overrides keyed by spawn-profile name (F6). */
  spawn_profiles?: Record<string, SpawnConfig>;
}

export interface LlamaServerConfig {
  /** Path to the llama-server binary. Required when any model uses provider: llama.cpp. */
  binary?: string;
  /** Default GPU layers when the model doesn't override. -1 = all. */
  n_gpu_layers?: number;
  /** Default context size when the model doesn't override. */
  default_num_ctx?: number;
  /** Batch size default. */
  n_batch?: number;
  /** Number of parallel request slots. */
  n_parallel?: number;
  /** KV-cache K quantization default (legacy int or llama.cpp string like q8_0). */
  type_k?: number | string;
  /** KV-cache V quantization default (legacy int or llama.cpp string like q8_0). */
  type_v?: number | string;
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
  /** Secret key name in VS Code SecretStorage - never a raw key. */
  secret_key_name: string;
  max_results?: number;
}

export interface EmbeddingsConfig {
  enabled?: boolean;
  model_path?: string;
  port?: number;
  auto_index_on_search?: boolean;
  max_file_size_kb?: number;
  include_globs?: string[];
  exclude_globs?: string[];
}

export interface ForgeConfig {
  models: ModelConfig[];
  active_model: string | null;
  /** Shared request-time defaults applied beneath base facts and profiles (F6). */
  defaults?: ProfileConfig;
  /** Named request-time role presets (F6). Referenced via `model@profile`. */
  profiles?: Record<string, ProfileConfig>;
  /** Migration shim: old suffixed model name → `base@profile` (F6). */
  aliases?: Record<string, string>;
  llama_server: LlamaServerConfig;
  search?: SearchConfig;
  embeddings?: EmbeddingsConfig;
  log_level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** Extra directories to scan for GGUF files (used by first-run wizard). */
  model_dirs?: string[];
  /** Path to a directory containing user-defined Nunjucks template overrides. */
  templates_dir?: string;
  /** Text injected into every system prompt via the template engine. */
  custom_instructions?: string;
  /** Default thinking/channel stripping behavior, overridable per model. */
  strip_thinking_channels?: boolean;
  /** Maximum number of llama-server processes to keep alive simultaneously. Default: 1. */
  max_simultaneous_models?: number;
  /** Ollama daemon supervision. When a model's local Ollama endpoint refuses
   *  connection, Forge can start `ollama serve` itself (default: on). */
  ollama?: {
    /** Auto-start `ollama serve` when a local endpoint is down. Default: true. */
    auto_start?: boolean;
    /** Explicit path to the ollama executable. Default: `ollama` on PATH,
     *  then the standard install location under %LOCALAPPDATA% on Windows. */
    executable?: string;
  };
  /** Optional localhost model-control API so an external orchestrator can ask
   *  Forge to load the right model on demand and discover its endpoint. */
  control_server?: {
    enabled?: boolean;
    /** Port for the localhost control API. Default: 8799. */
    port?: number;
  };
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
  /** External MCP stdio servers whose tools are bridged into the tool registry. */
  mcp_servers?: McpServerConfig[];
}

/** One external MCP stdio server to spawn and bridge tools from. */
export interface McpServerConfig {
  /** Display name, used as a log/warning label. Does not prefix tool names. */
  name: string;
  /** Executable to spawn (absolute path recommended). */
  command: string;
  /** Command-line arguments passed to the executable. */
  args?: string[];
}
