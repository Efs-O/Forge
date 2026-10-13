import type {
  ImageGenerationConfig,
  ImageSearchConfig,
  VideoConfig,
  VoiceConfig,
} from './mediaTypes';
export type {
  CloudImageBackendConfig,
  ImageBackendConfig,
  ImageGenerationConfig,
  ImageSearchConfig,
  SdcppImageBackendConfig,
  VideoConfig,
  VoiceConfig,
} from './mediaTypes';

import type { ToolPermission } from '../tools/ToolRegistry';
import type { EmbeddingPromptStyle } from '../search/embeddingPrompts';
import type { AgentBusConfig, AgentLinksConfig } from './agentBusSchema';
import type { RemoteContactsConfig } from './RemoteContactsConfig';
import type { DefaultsConfig, GroupConfig, ModelConfig, ProfileConfig } from './modelTypes';

/**
 * The model-definition types live in `modelTypes.ts` (the same seam the Zod
 * side has in `modelSchema.ts`) and are re-exported here, so every importer of
 * `config/types` keeps working unchanged.
 */
export type {
  DefaultsConfig,
  GroupConfig,
  ModelConfig,
  ModelProvider,
  ProfileConfig,
  SamplingConfig,
  SpawnConfig,
  SystemPromptMode,
} from './modelTypes';

export interface LlamaServerConfig {
  /** Path to the llama-server binary. Required when any model uses provider: llama.cpp. */
  binary?: string;
  /** Arguments passed to every llama-server process before model-specific arguments. */
  extra_llama_server_args?: string[];
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
  device?: string; // llama.cpp `--device` list for the embedding server, e.g. `CUDA2`
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

/** `jobs.gpu_gate` (validated by jobsSchema.ts). Absent means no sampled probe. */
export interface GpuGateConfig {
  /** nvidia-smi indices of the GPUs local models use. */
  gpus: number[];
  max_util_percent: number;
  max_idle_vram_mb: number;
  sample_seconds: number;
}

/** `jobs:` block (validated by jobsSchema.ts). Absent means no scheduler. */
export interface JobsConfig {
  enabled: boolean;
  /** Outbound fetch gate: a job fetches only from a host in this list. */
  allowed_hosts: string[];
  /** How many jobs may run at once. */
  max_concurrent: number;
  allow_cli_agents: boolean; // unattended jobs may drive Claude Code / Codex (cliAgentGate)
  /** Model for agent tasks that name none; hand-edited, never moved by a tab switch. */
  default_model?: string;
  gpu_gate?: GpuGateConfig;
}

export interface ForgeConfig {
  models: ModelConfig[];
  active_model: string | null;
  /** Named shared config bundles ("boards") models opt into via `group`/`groups`. */
  groups?: Record<string, GroupConfig>;
  /** Shared request-time defaults applied beneath base facts and profiles (F6). */
  defaults?: DefaultsConfig;
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
  /** Speech-to-text ingress. Off unless `enabled`. */
  voice?: VoiceConfig;
  /** `generate_image` backends. Absent means the tool is not advertised. */
  image_generation?: ImageGenerationConfig;
  /** Persistent agent jobs. Absent means no scheduler, no lease, no tool. */
  jobs?: JobsConfig;
  agent_bus?: AgentBusConfig;
  agent_links: AgentLinksConfig;
  /** Reverse image search. Absent means `image_search` is not advertised. */
  image_search?: ImageSearchConfig;
  log_level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** Extra directories to scan for GGUF files (used by first-run wizard). */
  model_dirs?: string[];
  /** Absolute folders outside the workspace that create_directory / delete_file may reach (read_file reads anywhere). */
  extra_file_roots?: string[];
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
  /** The elapsed-time check-in. The block is the switch: present, it
   *  advertises the `set_checkin` tool (the model estimates its own task
   *  length) and `after_minutes` is the fallback note for a model that sets
   *  none. Absent block = off: no tool, no note, no schema tokens. 5–240;
   *  read live at every drain, so removing it stops the note mid-task. */
  elapsed_time_note?: { after_minutes: number };
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
    /** Seconds to keep a recognized /command before deleting it from Telegram; 0 disables. */
    delete_command_messages_after: number;
    /**
     * Seconds to keep Forge's reply to a /command — and ephemeral host
     * notifications such as "model unloaded" — before deleting them from
     * Telegram; 0 disables.
     */
    delete_command_replies_after: number;
    /** Remote TOTP session policy. Enrollment/secrets remain in SecretStorage. */
    auth: {
      /** 0 disables inactivity expiry; otherwise 1–1440 minutes. */
      inactivity_timeout_minutes: number;
    };
    attachments: {
      enabled: boolean;
      retain_days: number | null;
      accept_pdf: boolean;
    };
    contacts: RemoteContactsConfig;
    workspace_aliases: Record<string, { path: string; display_name: string }>;
    /** Private-LAN receiver for a paired always-on WakeSleep relay. */
    wake_relay?: { enabled: boolean; host: string; port: number; relay_ip: string };
    telegram: { enabled: boolean };
    whatsapp: { enabled: boolean };
  };
  /** Tool permission gates. Defaults to read-only fs, no net/exec/git-write. */
  permissions?: {
    fs?: { read?: boolean; write?: boolean; delete?: boolean };
    net?: { search?: boolean; fetch?: boolean };
    exec?: { terminal?: boolean; headless?: boolean; shell?: 'pwsh' | 'powershell' | 'bash' };
    git?: { read?: boolean; write?: boolean };
    agents?: { delegate?: boolean; cloud_workers?: boolean };
    browser?: { enabled?: boolean };
    /**
     * `allow_vscode` (default false) opts in to controlling the ordinary VS Code
     * `code`/`code.exe` PROCESS — not a fork, not a title match, not the
     * `Chrome_WidgetWin_1` class. Inert while `enabled` is false, and each input
     * to a Code window still asks separately. See src/tools/desktop/targetWindowGate.ts.
     */
    desktop?: { enabled?: boolean; allow_vscode?: boolean };
  };
  /** Non-permission browser knobs (channel, headless, allowed_origins). */
  browser?: {
    channel?: 'chrome' | 'msedge' | 'chromium';
    headless?: boolean;
    allowed_origins?: string[];
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
