/**
 * The wire contract between a laptop Forge and the desktop Forge that renders
 * its media (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md). Both sides import these
 * schemas and texts, so a route or field changes in one place only.
 *
 * The routes are served by the cloud relay listener (8797). The listener
 * matches `"<METHOD> <path>"` exactly, so ids travel in the query string or the
 * body, never in the path.
 */
import { z } from 'zod';

/** Every media route, in the `<method> <path>` shape `CLOUD_RELAY_ROUTES` uses. */
export const REMOTE_MEDIA_ROUTES = Object.freeze([
  'GET /v1/media/capabilities',
  'POST /v1/media/jobs',
  'GET /v1/media/job',
  'GET /v1/media/file',
  'POST /v1/media/cancel',
] as const);

export const REMOTE_MEDIA_TOOLS = [
  'generate_image',
  'upscale_image',
  'generate_video',
  'generate_music',
] as const;
export type RemoteMediaTool = (typeof REMOTE_MEDIA_TOOLS)[number];

/** The arguments that name a file, per tool, and which way the file goes. An
 *  `input` must name an uploaded input; an `output` must be a plain relative
 *  path inside the job's `out/`. Any other path-valued argument does not exist. */
export const REMOTE_MEDIA_PATH_ARGS: Readonly<
  Record<RemoteMediaTool, Readonly<Record<string, 'input' | 'input-list' | 'output'>>>
> = Object.freeze({
  generate_image: { path: 'output', reference_paths: 'input-list' },
  upscale_image: { path: 'input' },
  generate_video: { image_path: 'input' },
  generate_music: { source_audio_path: 'input', lyrics_path: 'output' },
});

const JobId = z.string().regex(/^[a-f0-9-]{8,64}$/u);
const FileName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\\/:*?"<>|]+$/u, 'a bare file name, no folders');

export const RemoteMediaInputSchema = z
  .object({ arg: z.string().min(1).max(64), name: FileName, base64: z.string().min(1) })
  .strict();

export const RemoteMediaJobRequestSchema = z
  .object({
    tool: z.enum(REMOTE_MEDIA_TOOLS),
    /** Validated on the desktop by the tool's own argument handling. */
    args: z.record(z.string(), z.unknown()),
    client: z.string().min(1).max(120),
    inputs: z.array(RemoteMediaInputSchema).max(8).optional(),
  })
  .strict();
export type RemoteMediaJobRequest = z.infer<typeof RemoteMediaJobRequestSchema>;

export const RemoteMediaJobAcceptedSchema = z.object({ id: JobId }).strict();

export const REMOTE_MEDIA_JOB_STATES = ['queued', 'running', 'done', 'failed'] as const;

export const RemoteMediaFileSchema = z
  .object({
    name: FileName,
    bytes: z.number().int().nonnegative(),
    kind: z.enum(['image', 'video', 'audio', 'text']),
  })
  .strict();

export const RemoteMediaJobStatusSchema = z
  .object({
    id: JobId,
    state: z.enum(REMOTE_MEDIA_JOB_STATES),
    progress: z.string().max(500).optional(),
    error: z.string().max(4000).optional(),
    /** The tool's own result text, for the laptop to return to its model. */
    result: z.string().max(20_000).optional(),
    files: z.array(RemoteMediaFileSchema).optional(),
  })
  .strict();
export type RemoteMediaJobStatus = z.infer<typeof RemoteMediaJobStatusSchema>;

export const RemoteMediaCancelRequestSchema = z.object({ id: JobId }).strict();

const BackendCapabilitySchema = z
  .object({
    name: z.string().min(1),
    /** True for xai/openai/openai-compatible backends: billed per call. */
    paid: z.boolean(),
    confirm_each: z.boolean(),
    /** The tool's cost tag text, shown in the laptop's approval detail. */
    cost: z.string().optional(),
    reference_images: z.boolean(),
    sizes: z.array(z.string()).optional(),
  })
  .strict();

const EngineCapabilitySchema = z
  .object({ id: z.string().min(1), kind: z.string().min(1) })
  .strict();

/** Something the desktop has but will not serve, and the reason, so Check
 *  connection can say it instead of the laptop guessing. */
const RefusedSchema = z.object({ name: z.string().min(1), reason: z.string().min(1) }).strict();

/** One desktop tool's definition, as its own factory built it. The laptop
 *  advertises exactly this, so the argument schema has one owner (the desktop
 *  tool) and a desktop upgrade reaches the laptop's model with no laptop edit. */
const ToolDefinitionCapabilitySchema = z
  .object({
    type: z.literal('function'),
    function: z
      .object({
        name: z.enum(REMOTE_MEDIA_TOOLS),
        description: z.string(),
        parameters: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();

export const RemoteMediaCapabilitiesSchema = z
  .object({
    /** The definitions of the tools this desktop serves, and only those. */
    tools: z.array(ToolDefinitionCapabilitySchema),
    image: z
      .object({ default: z.string().optional(), backends: z.array(BackendCapabilitySchema) })
      .strict()
      .optional(),
    upscale: z.boolean(),
    video: z
      .object({ engines: z.array(EngineCapabilitySchema) })
      .strict()
      .optional(),
    music: z
      .object({ engines: z.array(EngineCapabilitySchema) })
      .strict()
      .optional(),
    refused: z.array(RefusedSchema),
    /** Largest request body the desktop accepts, so the laptop refuses first. */
    max_body_bytes: z.number().int().positive(),
  })
  .strict();
export type RemoteMediaCapabilities = z.infer<typeof RemoteMediaCapabilitiesSchema>;

/** The error texts both sides pin with whole-text tests. */
export const REMOTE_MEDIA_TEXT = Object.freeze({
  off: 'media relay is off',
  /** Only the first line of `detail`: that is the approval card's headline, and
   *  the rest is the model's own prompt, which used to read as part of the
   *  refusal. The sentence also says the job was not run, which it never did. */
  notListed: (detail: string, name: string, list: string): string =>
    `Not run: ${detail.split('\n')[0].trim()} is not allowed from the laptop. ` +
    `Add ${name} to cloud_relay.media.${list} in the desktop's policy.yaml to allow it.`,
  unreachable: (origin: string): string =>
    `The desktop (${origin}) did not answer. Image, video and music generation run there: ` +
    'start Forge on the desktop, or run "Forge: Check connection to my desktop".',
  pathRefused: (arg: string): string =>
    `${arg} must name a file uploaded with the job; a path on the desktop is not accepted.`,
  outputRefused: (arg: string): string =>
    `${arg} must be a relative path with no ".." and no drive or root.`,
  queueFull: (limit: number): string =>
    `The desktop is already running or queuing ${String(limit)} media jobs; try again when one finishes.`,
});
