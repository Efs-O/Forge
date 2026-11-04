import { z } from 'zod';

const ModelPathsSchema = z
  .object({
    diffusion: z.string().default(''),
    video_vae: z.string().default(''),
    audio_vae: z.string().default(''),
    text_encoder: z.string().default(''),
    latent_upscaler: z.string().default(''),
    prompt_enhancer: z.string().optional(),
  })
  .strict();

const CudaDevicesSchema = z.array(z.number().int().nonnegative()).min(1);
const EngineIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/);

const Ltx25EngineSchema = z
  .object({
    id: EngineIdSchema,
    kind: z.literal('ltx25'),
    models: ModelPathsSchema.default({
      diffusion: '',
      video_vae: '',
      audio_vae: '',
      text_encoder: '',
      latent_upscaler: '',
    }),
    cuda_devices: CudaDevicesSchema.default([2]),
    min_free_vram_mb: z.number().int().positive().default(11_000),
  })
  .strict();

const H3EngineSchema = z
  .object({
    id: EngineIdSchema,
    kind: z.literal('comfyui_workflow'),
    models: z
      .object({ diffusion: z.string().default('') })
      .strict()
      .default({ diffusion: '' }),
    workflow: z.string().default(''),
    cuda_devices: CudaDevicesSchema.default([0]),
    min_free_vram_mb: z.number().int().positive().default(15_000),
    reserve_vram_gb: z.number().finite().nonnegative().default(0),
  })
  .strict();

const AceStepEngineSchema = z
  .object({
    id: EngineIdSchema,
    kind: z.literal('ace_standalone'),
    root: z.string().default(''),
    checkpoints: z.string().default(''),
    cuda_devices: CudaDevicesSchema.default([2]),
    min_free_vram_mb: z.number().int().positive().default(11_000),
  })
  .strict();

const StableAudioEngineSchema = z
  .object({
    id: EngineIdSchema,
    kind: z.literal('comfyui_sa3'),
    checkpoint: z.string().default(''),
    text_encoder: z.string().default(''),
    cuda_devices: CudaDevicesSchema.default([2]),
    min_free_vram_mb: z.number().int().positive().default(11_000),
    max_seconds: z.number().int().positive().max(380).default(380),
  })
  .strict();

const AnalyzerSchema = z
  .object({
    kind: z.literal('flamingo_dlt').default('flamingo_dlt'),
    launcher: z.string().default(''),
  })
  .strict();

const VideoConfigSchema = z
  .object({
    default_seconds: z.number().finite().positive().default(5),
    default_size: z
      .tuple([
        z
          .number()
          .int()
          .positive()
          .refine((value) => value % 64 === 0),
        z
          .number()
          .int()
          .positive()
          .refine((value) => value % 64 === 0),
      ])
      .default([1344, 768]),
    default_fps: z.number().int().positive().default(24),
    still_backend: z.string().default(''),
    engines: z.array(z.discriminatedUnion('kind', [Ltx25EngineSchema, H3EngineSchema])).default([]),
  })
  .strict();

const MusicConfigSchema = z
  .object({
    default_seconds: z.number().finite().positive().default(120),
    analyzer: AnalyzerSchema.default({ kind: 'flamingo_dlt', launcher: '' }),
    engines: z
      .array(z.discriminatedUnion('kind', [AceStepEngineSchema, StableAudioEngineSchema]))
      .default([]),
  })
  .strict();

const ComfyUiConfigSchema = z
  .object({
    root: z.string().default(''),
    python: z.string().default(''),
    port: z.number().int().min(1).max(65_535).default(8190),
  })
  .strict();

/** Optional local media engines. An absent block leaves all media tools off. */
export const MediaConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    output_dir: z.string().min(1).default('media'),
    comfyui: ComfyUiConfigSchema.default({ root: '', python: '', port: 8190 }),
    ffmpeg: z.string().min(1).default('ffmpeg'),
    video: VideoConfigSchema.default({
      default_seconds: 5,
      default_size: [1344, 768],
      default_fps: 24,
      still_backend: '',
      engines: [],
    }),
    music: MusicConfigSchema.default({
      default_seconds: 120,
      analyzer: { kind: 'flamingo_dlt', launcher: '' },
      engines: [],
    }),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const [category, engines] of [
      ['video', config.video.engines],
      ['music', config.music.engines],
    ] as const) {
      const seen = new Set<string>();
      for (const [index, engine] of engines.entries()) {
        if (seen.has(engine.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [category, 'engines', index, 'id'],
            message: `duplicate media engine id "${engine.id}"`,
          });
        }
        seen.add(engine.id);
      }
    }
  });

export type MediaConfig = z.infer<typeof MediaConfigSchema>;
export type MediaVideoEngineConfig = MediaConfig['video']['engines'][number];
export type MediaMusicEngineConfig = MediaConfig['music']['engines'][number];
