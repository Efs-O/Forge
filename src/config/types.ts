import type { ToolPermission } from '../tools/ToolRegistry';
import type { EmbeddingPromptStyle } from '../search/embeddingPrompts';

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

/**
 * How a `system_prompt` combines with Forge's own template.
 * - `append` (default): template first, then the prompt beneath it.
 * - `replace`: send only the prompt; the template is not rendered. For models
 *   that must not be told they are Forge — e.g. a personal-recall fine-tune
 *   that would otherwise answer as a codebase assistant.
 */
export type SystemPromptMode = 'append' | 'replace';

/** Runtime provider for a model or group entry. */
export type ModelProvider =
  | 'llama.cpp'
  | 'ollama'
  | 'xai'
  | 'openrouter'
  | 'openai'
  | 'openai-compatible'
  | 'cli';

/**
 * A named bundle of shared config ("board") that models opt into via
 * `group`/`groups`. Purely additive — precedence is
 * `defaults < group(s) < model fields < profile` (ConfigResolver owns the
 * merge). See docs/plans/CONFIG_OVERHAUL_PLAN.md §2.1.
 */
export interface GroupConfig {
  provider?: ModelProvider;
  endpoint?: string;
  spawn?: SpawnConfig;
  sampling?: SamplingConfig;
  num_ctx?: number;
  think?: boolean;
  reasoning_effort?: 'high' | 'medium' | 'low' | 'none';
  strip_tools?: boolean;
  strip_thinking_channels?: boolean;
  system_prompt?: string;
  system_prompt_mode?: SystemPromptMode;
  capabilities?: ('tool-call' | 'vision' | 'long-context')[];
  max_output_tokens?: number;
  /** Tool rounds per sidebar turn for models in this group. See ModelConfig. */
  max_tool_rounds?: number;
  /** Tool-name allowlist for models in this group. */
  tools?: string[];
  /** Per-tool max invocations per turn for models in this group. */
  tool_call_limits?: Record<string, number>;
}

/** Request-time role preset applied to a base model per request. */
export interface ProfileConfig {
  system_prompt?: string;
  system_prompt_mode?: SystemPromptMode;
  sampling?: SamplingConfig;
  think?: boolean;
  reasoning_effort?: 'high' | 'medium' | 'low' | 'none';
  strip_tools?: boolean;
  strip_thinking_channels?: boolean;
  capabilities?: ('tool-call' | 'vision' | 'long-context')[];
  /** Tool rounds per sidebar turn. Set on `defaults` to cover every model. */
  max_tool_rounds?: number;
}

export interface ModelConfig {
  /** Display name shown in the sidebar model picker. */
  name: string;
  /** Runtime provider for this model entry. */
  provider?: ModelProvider;
  /** Executable name or absolute path for provider: cli (e.g. `claude`, `codex`). */
  cli?: string;
  /** Model name or alias passed directly to the external CLI (e.g. `opus`). */
  cli_model?: string;
  /** Absolute path to the .gguf file. Required for llama.cpp models. */
  gguf_path?: string;
  /** Optional path to the vision projector .gguf (mmproj). Enables multimodal image input. */
  mmproj_path?: string;
  /**
   * Drop images from the model-facing copy once this many later USER messages
   * exist. `0` removes an image on the next user prompt; omitted = never age out
   * (the default). Counts user turns, not protocol messages, so a tool-heavy
   * round cannot evict an image the user just attached.
   */
  image_retention_turns?: number;
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
  /**
   * Per-model system prompt. By default this is APPENDED beneath Forge's
   * template — set `system_prompt_mode: 'replace'` to send it alone.
   */
  system_prompt?: string;
  /** Whether `system_prompt` extends Forge's template or replaces it. */
  system_prompt_mode?: SystemPromptMode;
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
  /** Single group ("board") this model inherits shared config from. Ignored when `groups` is set. */
  group?: string;
  /** Multiple groups merged in listed order (later wins); each group must exist in `ForgeConfig.groups`. */
  groups?: string[];
  /** Short, memorable identifier for fuzzy worker/chat-picker resolution (e.g. `gemma4`). Must be globally unique against all names/aliases/short_names. */
  short_name?: string;
  /** Free-tag category for the Model Manager UI (e.g. coding, vision, worker, cloud). */
  category?: string;
  /** User-authored note, first-class so it survives YAML rewrites without depending on comments. */
  comment?: string;
  /** Per-model tool-name allowlist override. Overrides any inherited group allowlist. */
  tools?: string[];
  /** Per-model tool-call budget override, merged over any inherited group budget. */
  tool_call_limits?: Record<string, number>;
  /** Per-model output-token cap override, merged over any inherited group value. */
  max_output_tokens?: number;
  /**
   * Tool rounds this model may spend on one sidebar turn before the loop stops.
   * Falls back to `MAX_TOOL_ROUNDS` (500).
   *
   * A round is one model reply, so this is a ceiling on how many steps a single
   * request may take — and the right value is a property of the WORK, not of
   * Forge. A multi-file refactor legitimately spends dozens of rounds landing
   * edits; a chat model answering questions never approaches it. One hard-coded
   * constant cannot serve both, and the cost of guessing low is a turn killed
   * mid-refactor with the remaining edits unmade.
   */
  max_tool_rounds?: number;
}

export interface LlamaServerConfig {
  /** Path to the llama-server binary. Required when any model uses provider: llama.cpp. */
  binary?: string;
  /** Default GPU layers when the model doesn't override. Defaults to 999 (every
   *  layer). NOT -1: on llama.cpp b10430+ that means auto-fit, which silently
   *  leaves part of the model on the CPU. */
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

/** Opt-in machine-wide reuse for compatible direct llama.cpp servers. */
export interface SharedRuntimeConfig {
  enabled: boolean;
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
  n_ctx?: number;
  prompt_style?: EmbeddingPromptStyle;
  auto_index_on_search?: boolean;
  /** Ask before starting the embedding server when it is cold. */
  confirm_on_start?: boolean;
  /** Stop Forge-owned embedding server after this many idle milliseconds. */
  idle_timeout_ms?: number;
  max_file_size_kb?: number;
  include_globs?: string[];
  exclude_globs?: string[];
}

/** Raw `video:` block. Defaults live in `videoTool.ts` (VIDEO_DEFAULTS). */
export interface VideoConfig {
  max_duration_seconds?: number;
  max_frames?: number;
  /** Longest frame edge in pixels. The dominant term in prompt cost. */
  frame_max_dimension?: number;
  /** ffmpeg -q:v: 2 is best quality, higher is smaller. */
  frame_quality?: number;
  /** Explicit ffmpeg executable. Empty means resolve from PATH / WinGet. */
  ffmpeg_path?: string;
}

export interface ForgeConfig {
  models: ModelConfig[];
  active_model: string | null;
  /** Named shared config bundles ("boards") models opt into via `group`/`groups`. */
  groups?: Record<string, GroupConfig>;
  /** Shared request-time defaults applied beneath base facts and profiles (F6). */
  defaults?: ProfileConfig;
  /** Named request-time role presets (F6). Referenced via `model@profile`. */
  profiles?: Record<string, ProfileConfig>;
  /** Migration shim: old suffixed model name → `base@profile` (F6). */
  aliases?: Record<string, string>;
  llama_server: LlamaServerConfig;
  shared_runtime?: SharedRuntimeConfig;
  search?: SearchConfig;
  embeddings?: EmbeddingsConfig;
  /** `view_video` frame extraction. Top-level only: tools are registered once
   *  at activation and never see the per-turn resolved model. */
  video?: VideoConfig;
  log_level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** Extra directories to scan for GGUF files (used by first-run wizard). */
  model_dirs?: string[];
  /** Path to a directory containing user-defined Nunjucks template overrides. */
  templates_dir?: string;
  /** Text injected into every system prompt via the template engine. */
  custom_instructions?: string;
  /** Workspace instruction-file behavior for native Forge agents. */
  forge_instructions?: {
    /** Create FORGE.md in each discovered repository when it is absent. */
    auto_create?: boolean;
  };
  /** Default thinking/channel stripping behavior, overridable per model. */
  strip_thinking_channels?: boolean;
  /** Maximum number of llama-server processes to keep alive simultaneously. Default: 1. */
  max_simultaneous_models?: number;
  /** Maximum warm direct-chat CLI processes. Default: 4. */
  max_cli_agents?: number;
  /** Dispose an idle direct-chat CLI process after this many milliseconds. Default: 900000. */
  cli_idle_timeout_ms?: number;
  /** Ollama daemon supervision. When a model's local Ollama endpoint refuses
   *  connection, Forge can start `ollama serve` itself (default: on). */
  ollama?: {
    /** Auto-start `ollama serve` when a local endpoint is down. Default: true. */
    auto_start?: boolean;
    /** Explicit path to the ollama executable. Default: `ollama` on PATH,
     *  then the standard install location under %LOCALAPPDATA% on Windows. */
    executable?: string;
  };
  /** Automatic context compaction. Off by default — compaction is the user's
   *  call, and it changes what the model can still see. */
  auto_compact?: {
    /** Run /compact automatically when the context passes `at`. Default: false. */
    enabled?: boolean;
    /** Fraction of the context window that triggers it. Default: 0.85.
     *  Deliberately not ~0.95: the summarization request sends the transcript,
     *  so it needs room left to run. */
    at?: number;
    /** After an automatic compaction, continue the active task from its summary
     *  and retained tail. Default: true. A user-typed /compact always resumes. */
    resume?: boolean;
  };
  /** Optional localhost model-control API so an external orchestrator can ask
   *  Forge to load the right model on demand and discover its endpoint. */
  control_server?: {
    enabled?: boolean;
    /** Port for the localhost control API. Default: 8799. */
    port?: number;
  };
  /** Remote behavior only. Tokens and owner IDs live in SecretStorage. */
  remote?: {
    enabled: boolean;
    queue_limit: number;
    max_message_chars: number;
    rate_limit_per_minute: number;
    /** Remote TOTP session policy. Enrollment/secrets remain in SecretStorage. */
    auth: {
      /** 0 disables inactivity expiry; otherwise 1–1440 minutes. */
      inactivity_timeout_minutes: number;
    };
    attachments: {
      enabled: boolean;
      retain_days: number;
      accept_pdf: boolean;
    };
    workspace_aliases: Record<string, { path: string; display_name: string }>;
    telegram: { enabled: boolean };
    whatsapp: { enabled: boolean };
  };
  /** Tool permission gates. Defaults to read-only fs, no net/exec/git-write. */
  permissions?: {
    fs?: { read?: boolean; write?: boolean; delete?: boolean };
    net?: { search?: boolean; fetch?: boolean };
    exec?: { terminal?: boolean; headless?: boolean };
    git?: { read?: boolean; write?: boolean };
    agents?: { delegate?: boolean; cloud_workers?: boolean };
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
  /**
   * Cap on each tool result's length in chars before it enters the
   * conversation; oversized results are truncated with a visible marker.
   * Defaults to DEFAULT_MAX_RESULT_CHARS in mcpBridge.
   */
  max_result_chars?: number;
  /** Per-tool capability classification; unlisted MCP tools default to read. */
  tool_permissions?: Record<string, ToolPermission>;
}
