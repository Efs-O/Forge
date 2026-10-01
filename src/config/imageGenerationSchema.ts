import { z } from 'zod';

const BackendNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, 'use letters, digits, dot, underscore or dash');

/**
 * Cloud image backends use the OpenAI-style `POST /v1/images/generations` endpoint.
 *
 * `openrouter` is deliberately absent: OpenRouter generates images through
 * chat completions with `modalities`, not this endpoint, so listing it here
 * would advertise a backend that fails on every call.
 */
const CloudImageBackendSchema = z.object({
  name: BackendNameSchema,
  provider: z.enum(['xai', 'openai', 'openai-compatible']),
  /** Provider model id, e.g. `grok-imagine-image-2.0`. */
  model: z.string().min(1),
  /** SecretStorage key. For `xai`, OpenCode's OAuth file is the fallback. */
  api_key_secret: z.string().min(1).optional(),
  /** Base URL; required for `openai-compatible` and ignored otherwise. */
  endpoint: z.string().url().optional(),
  /**
   * Ask before every call, even under /clanker. On by default because each
   * image is billed: a looping model must not buy forty of them unasked.
   */
  confirm_each: z.boolean().default(true),
});

const SdcppImageBackendSchema = z.object({
  name: BackendNameSchema,
  provider: z.literal('sdcpp'),
  binary: z.string().min(1),
  diffusion_model: z.string().min(1),
  text_encoder: z.string().min(1),
  vae: z.string().min(1),
  cuda_device: z.number().int().nonnegative(),
  text_encoder_on_cpu: z.boolean(),
  port: z.number().int().min(1).max(65535),
  min_free_vram_mb: z.number().int().positive(),
  idle_timeout_ms: z.number().int().positive(),
  request_timeout_ms: z.number().int().positive(),
  defaults: z.object({
    steps: z.number().int().positive(),
    cfg_scale: z.number().finite().positive(),
    sampler: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  extra_args: z.array(z.string()),
  confirm_on_start: z.boolean(),
  confirm_each: z.boolean(),
});

const ImageBackendSchema = z
  .discriminatedUnion('provider', [CloudImageBackendSchema, SdcppImageBackendSchema])
  .superRefine((backend, ctx) => {
    if (backend.provider === 'openai-compatible' && !backend.endpoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoint'],
        message: 'provider openai-compatible requires endpoint',
      });
    }
    if (backend.provider !== 'xai' && backend.provider !== 'sdcpp' && !backend.api_key_secret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['api_key_secret'],
        message: `provider ${backend.provider} requires api_key_secret`,
      });
    }
    if (
      backend.provider === 'sdcpp' &&
      backend.idle_timeout_ms < backend.request_timeout_ms + 60_000
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['idle_timeout_ms'],
        message: 'must be at least request_timeout_ms + 60000',
      });
    }
  });

/** `image_generation:` — absent means the `generate_image` tool is never advertised. */
export const ImageGenerationConfigSchema = z
  .object({
    backends: z.array(ImageBackendSchema).min(1),
    /** Backend used when the model names none. Defaults to the first entry. */
    default: z.string().min(1).optional(),
    /** Workspace-relative folder for images saved without an explicit path. */
    output_dir: z.string().min(1).default('generated-images'),
  })
  .superRefine((cfg, ctx) => {
    const names = cfg.backends.map((backend) => backend.name);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backends'],
        message: `duplicate backend name "${duplicate}"`,
      });
    }
    if (cfg.default && !names.includes(cfg.default)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: `default "${cfg.default}" is not one of: ${names.join(', ')}`,
      });
    }
  })
  .optional();
