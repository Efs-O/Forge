import { z } from 'zod';

/** Local speech input/output configuration. Paths stay explicit by design. */
export const VoiceConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** whisper-cli.exe from a CUDA build of whisper.cpp. */
    whisper_binary: z.string().min(1).optional(),
    /** ggml-large-v3.bin. Verify the size: a truncated download still loads. */
    whisper_model: z.string().min(1).optional(),
    /** `auto` detects per utterance; an ISO code forces one. */
    language: z.string().min(1).default('auto'),
    compute: z
      .object({
        /** false passes `-ng`, forcing CPU. */
        gpu: z.boolean().default(true),
        /** `-dev N`, in whisper.cpp's CUDA ordering. */
        device: z.number().int().min(0).optional(),
        /** `-t N`. */
        threads: z.number().int().positive().optional(),
        /** `-bs N`. */
        beam_size: z.number().int().positive().optional(),
        /** `-fa` / `-nfa`. */
        flash_attn: z.boolean().optional(),
      })
      .optional(),
    server: z
      .object({
        enabled: z.boolean().default(false),
        /** whisper-server executable; required when resident mode is enabled. */
        binary: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).default(8092),
        /** Zero keeps the server resident until Forge deactivates. */
        idle_timeout_ms: z.number().int().min(0).default(600_000),
        confirm_on_start: z.boolean().default(true),
      })
      .optional(),
    /** Removed key retained solely for the root schema's actionable rejection. */
    keep_model_loaded: z.boolean().optional(),
    input: z
      .object({
        max_bytes: z
          .number()
          .int()
          .positive()
          .default(25 * 1024 * 1024),
        max_seconds: z.number().int().positive().default(300),
      })
      .optional(),
    bias_prompt: z.string().default(''),
    trim_silence: z.boolean().default(true),
    output: z
      .object({
        enabled: z.boolean().default(false),
        piper_binary: z.string().min(1).optional(),
        voices_dir: z.string().min(1).optional(),
        voice_en: z.string().min(1).optional(),
        voice_el: z.string().min(1).optional(),
        max_chars: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .optional();
