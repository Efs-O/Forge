/** One `image_generation.backends[]` entry (validated by imageGenerationSchema.ts). */
export interface ImageBackendConfig {
  name: string;
  provider: 'xai' | 'openai' | 'openai-compatible';
  model: string;
  api_key_secret?: string;
  endpoint?: string;
  confirm_each: boolean;
}

export interface ImageGenerationConfig {
  backends: ImageBackendConfig[];
  default?: string;
  output_dir: string;
}

/** `image_search:` block (validated by imageSearchSchema.ts). */
export interface ImageSearchConfig {
  provider: 'serpapi_lens';
  /** Secret key name in VS Code SecretStorage - never a raw key. */
  secret_key_name: string;
  max_results: number;
  confirm_upload: boolean;
  thumbnails: number;
  timeout_ms: number;
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

/**
 * Raw `voice:` block. Engine and model size are decided (§6.1b), so only their
 * locations are configurable -- see VoiceConfigSchema for why.
 */
export interface VoiceConfig {
  enabled?: boolean;
  /** whisper-cli.exe from a CUDA build of whisper.cpp. */
  whisper_binary?: string;
  /** ggml-large-v3.bin. */
  whisper_model?: string;
  /** `auto`, or an ISO code to force one language. */
  language?: string;
  /** Which device decodes. Absent means whisper.cpp's defaults (GPU 0). */
  compute?: {
    /** false forces CPU via `-ng`. */
    gpu?: boolean;
    /** CUDA ordinal for `-dev N`, in llama.cpp's ordering, not nvidia-smi's. */
    device?: number;
    threads?: number;
    beam_size?: number;
    flash_attn?: boolean;
  };
  /** Optional resident whisper-server. The CLI path remains the default. */
  server?: {
    enabled?: boolean;
    binary?: string;
    port?: number;
    idle_timeout_ms?: number;
    confirm_on_start?: boolean;
  };
  /** Removed configuration key retained only so validation can reject it clearly. */
  keep_model_loaded?: boolean;
  input?: { max_bytes?: number; max_seconds?: number };
  /** §6.4 decoder bias. Empty disables. */
  bias_prompt?: string;
  trim_silence?: boolean;
  /** Spoken replies via Piper. Flagged independently of STT (R6). */
  output?: {
    enabled?: boolean;
    piper_binary?: string;
    voices_dir?: string;
    voice_en?: string;
    voice_el?: string;
    max_chars?: number;
  };
}
