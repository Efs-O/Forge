/**
 * The config types describing one entry under `models:` / `groups:` /
 * `profiles:` — the model-definition seam, the same one the Zod side keeps in
 * `modelSchema.ts`. They are moved out of `types.ts` only to keep that file
 * under the 500-line lint stop; `types.ts` re-exports all of them, so nothing
 * imports this file directly.
 */

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
  token_count?: 'tokenize' | 'count_tokens' | 'estimate';
  endpoint?: string;
  spawn?: SpawnConfig;
  sampling?: SamplingConfig;
  num_ctx?: number;
  think?: boolean;
  reasoning_effort?: 'xhigh' | 'high' | 'medium' | 'low' | 'none';
  /** reasoning_effort sent when Forge turns thinking off (the compaction summary). See ModelConfig. */
  thinking_off_effort?: 'xhigh' | 'high' | 'medium' | 'low' | 'none';
  strip_tools?: boolean;
  strip_thinking_channels?: boolean;
  system_prompt?: string;
  system_prompt_mode?: SystemPromptMode;
  capabilities?: ('tool-call' | 'vision' | 'long-context')[];
  max_output_tokens?: number;
  /** Tool rounds per sidebar turn for models in this group. See ModelConfig. */
  max_tool_rounds?: number;
  tool_groups?: { eager: string[] };
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
  reasoning_effort?: 'xhigh' | 'high' | 'medium' | 'low' | 'none';
  strip_tools?: boolean;
  strip_thinking_channels?: boolean;
  capabilities?: ('tool-call' | 'vision' | 'long-context')[];
  /** Tool rounds per sidebar turn. Set on `defaults` to cover every model. */
  max_tool_rounds?: number;
}

export interface DefaultsConfig extends ProfileConfig {
  tool_groups?: { eager: string[] };
}

export interface ModelConfig {
  /** Display name shown in the sidebar model picker. */
  name: string;
  /** Server-side model identifier sent in OpenAI-compatible requests. */
  model?: string;
  /** Runtime provider for this model entry. */
  provider?: ModelProvider;
  /** Host-block tokenizer choice used by compaction admission. */
  token_count?: 'tokenize' | 'count_tokens' | 'estimate';
  /** Executable name or absolute path for provider: cli (e.g. `claude`, `codex`). */
  cli?: string;
  /** Model name or alias passed directly to the external CLI (e.g. `opus`). */
  cli_model?: string;
  /** Absolute path to the .gguf file. Required for llama.cpp models. */
  gguf_path?: string;
  /** Optional path to the vision projector .gguf (mmproj). Enables multimodal image input. */
  mmproj_path?: string;
  /**
   * Per-model override of the llama-server executable, for a patched fork (e.g.
   * the Unsloth MTP fork). Absent = use the global `llama_server.binary`.
   */
  llama_server_binary?: string;
  /** Maximum time to wait for this model's llama-server health endpoint at startup. */
  startup_timeout_ms?: number;
  /**
   * Drop images from the model-facing copy once this many later USER messages
   * exist. `0` removes an image on the next user prompt; omitted = never age out
   * (the default). Counts user turns, not protocol messages, so a tool-heavy
   * round cannot evict an image the user just attached.
   */
  image_retention_turns?: number;
  /**
   * Log file of a server Forge does not spawn (Strata, a hand-started
   * llama-server). Forge follows it into the "Forge - <display name> log"
   * output channel from activation on, starting at the file's current end.
   */
  server_log?: string;
  /**
   * openai-compatible only: path POSTed against `endpoint` to free the local
   * server's GPU/RAM (Strata: `/unload`; it reloads on its next request). Marks
   * the model as holding VRAM, so Forge's unload commands reach it and it never
   * loads beside a llama.cpp/Ollama model. See ExternalModelServers.
   */
  unload_path?: string;
  /** Opt in to launching `stop_command` when the last Forge window exits. */
  stop_on_exit?: boolean;
  /** Executable plus argv; spawned directly, never interpreted as a shell string. */
  stop_command?: string[];
  /** Executable plus argv launched (detached) before a request when the server is down.
   *  An argv item equal to `{num_ctx}` is replaced with this model's configured context. */
  start_command?: string[];
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
  chat_template_thinking?: boolean;
  /** Ollama reasoning effort level when think is enabled. */
  reasoning_effort?: 'xhigh' | 'high' | 'medium' | 'low' | 'none';
  /**
   * The `reasoning_effort` Forge sends when it turns thinking off for a request
   * (today: the compaction summary when its budget reserves no reasoning tokens).
   * openai-compatible defaults to 'none'. xai/openrouter/openai name their effort
   * levels differently, so Forge sends nothing extra for them unless this is set.
   * llama.cpp and Ollama use `enable_thinking: false` and ignore it.
   */
  thinking_off_effort?: 'xhigh' | 'high' | 'medium' | 'low' | 'none';
  /** Request-time profiles exposed for this model; [] disables them. */
  profiles?: string[];
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
  /** Label shown in the sidebar picker and the remote (Telegram) model list. Presentation only: selection, routing and `active_model` still use `name`. */
  display_name?: string;
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
   * Falls back to `MAX_TOOL_ROUNDS` (1000).
   *
   * A round is one model reply, so this is a ceiling on how many steps a single
   * request may take — and the right value is a property of the WORK, not of
   * Forge. A multi-file refactor legitimately spends dozens of rounds landing
   * edits; a chat model answering questions never approaches it. One hard-coded
   * constant cannot serve both, and the cost of guessing low is a turn killed
   * mid-refactor with the remaining edits unmade.
   */
  max_tool_rounds?: number;
  /** Lazy native tool groups advertised from the first request. */
  tool_groups?: { eager: string[] };
}
