import { z } from 'zod';
import { LOCAL_HEADERS_TIMEOUT_MS } from '../llm/localLlamaFetch';

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
  /**
   * Vision tower (mmproj GGUF) that lets a reference image condition the
   * render. Optional on purpose: text-to-image works without it, an existing
   * config keeps working, and `reference_paths` refuses with this key named
   * when it is absent. `sd-server` validates the tower against the diffusion
   * model's metadata at start (probe 0.8: a wrong GGUF exits 1 in ~5s), so a
   * bad path is loud rather than silently garbage.
   */
  vision_encoder: z.string().min(1).optional(),
  /**
   * `--auto-fit on|off`. `true` is the measured fast mode: 410s vs 549s for the
   * same 768x1280 render. Only ever places work on the card named by
   * `cuda_device` (the spawn sets `CUDA_VISIBLE_DEVICES`) or in system RAM.
   */
  auto_fit: z.boolean().default(true),
  /**
   * Per-device GiB budget `sd-server` gives its managed weights and runner
   * buffers under auto-fit. Absent means the flag is not passed at all, which
   * is the pre-0.16 behaviour on every card. Raise it when a multi-reference
   * render drops the prefix cache (`insufficient memory for prefix caching`);
   * 9 was enough for one reference and 11 for two on a 12 GB card.
   */
  max_vram_gib: z.number().int().min(1).max(64).optional(),
  /**
   * Longest edge, in pixels, a reference image is downscaled to before it is
   * sent. The dominant cost in an edit: two full-size references took 20 min
   * where one at 768px took 3. Being a config field is why no fallback literal
   * for it exists in `sdcppReferenceInput.ts`.
   */
  max_reference_edge_px: z.number().int().min(256).max(1536).default(768),
  port: z.number().int().min(1).max(65535),
  min_free_vram_mb: z.number().int().positive(),
  idle_timeout_ms: z.number().int().positive(),
  // The render goes through localLlamaFetch, whose headers timeout would cut a
  // longer deadline short as a bare transport fault.
  request_timeout_ms: z.number().int().positive().max(LOCAL_HEADERS_TIMEOUT_MS),
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

/** Reference images an edit may carry. Cap enforced, not advisory: each one is
 *  a conditioning pass and a share of the VRAM the prefix cache needs. */
export const MAX_REFERENCE_IMAGES = 4;

/** Variations one call may produce. Each is a full render, so 2 is already minutes. */
export const MAX_IMAGE_VARIATIONS = 2;

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

/** Default workspace-relative folder for saved images, shared with any tool
 *  that must fall back when no `image_generation:` block is configured. */
export const DEFAULT_IMAGE_OUTPUT_DIR = 'generated-images';

/** `image_generation:` — absent means the `generate_image` tool is never advertised. */
export const ImageGenerationConfigSchema = z
  .object({
    backends: z.array(ImageBackendSchema).min(1),
    /** Backend used when the model names none. Defaults to the first entry. */
    default: z.string().min(1).optional(),
    /** Workspace-relative folder for images saved without an explicit path. */
    output_dir: z.string().min(1).default(DEFAULT_IMAGE_OUTPUT_DIR),
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
