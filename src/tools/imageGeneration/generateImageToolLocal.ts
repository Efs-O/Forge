import * as fs from 'fs/promises';
import * as path from 'path';
import type { SdcppImageBackendConfig } from '../../config/types';
import { resolveRealWorkspacePath, resolveWorkspacePath } from '../../util/WorkspacePaths';
import { MAX_REFERENCE_IMAGES } from '../../config/imageGenerationSchema';
import { resolveFfmpeg, type FfmpegTools } from '../ffmpegLocate';
import { referenceRefusal } from './sdcppErrors';
import {
  describePreparedReferences,
  prepareReferences,
  type PreparedReference,
  type RunFfmpeg,
} from './sdcppReferenceInput';
import { runSdcppImageJob, type SdcppJobResult } from './sdcppJobPoll';
import {
  generateSdcppImage,
  sdcppSizeFor,
  type SdcppGeneratedImage,
  type SdcppImageRequest,
} from './sdcppImageBackend';

/**
 * The `sdcpp` half of `generate_image`: reference-image handling and the choice
 * of request shape. Split from `generateImageTool.ts` because the reference
 * rules (sandbox, de-duplication, cap, downscale, refusal copy) are their own
 * concern with their own tests, and because the tool file must stay under the
 * 500-line gate while it still owns dispatch, saving and delivery.
 */

/** The async job request shape, re-exported so the tool layer needs no second import. */
export type SdcppJobRequest = Parameters<typeof runSdcppImageJob>[0];

export interface LocalRenderDeps {
  generateLocal?: (request: SdcppImageRequest) => Promise<SdcppGeneratedImage>;
  generateJob?: (request: Parameters<typeof runSdcppImageJob>[0]) => Promise<SdcppJobResult>;
  /** From `video.ffmpeg_path`; empty resolves from PATH/WinGet. One owner for the setting. */
  ffmpegPath?: string;
  /** Injectable for tests: a located ffmpeg pair, so a unit test spawns nothing. */
  ffmpegTools?: FfmpegTools;
  /** Injectable for tests: the ffmpeg/ffprobe spawn itself. */
  runReference?: RunFfmpeg;
  /** Injectable so a test can prove nothing was spawned for a refused input. */
  onReferenceSpawn?: (argv: string[]) => void;
  /** Injectable: the real seed is random, so a rerender is not a byte copy. */
  seed?: () => number;
}

export interface ResolvedReferences {
  /** Base64 PNGs in the order they will be sent. */
  images: string[];
  prepared: PreparedReference[];
  /** Sentences for the tool result: de-duplication and any downscale. */
  notes: string[];
  /** Resolved absolute paths, for the output-collision check. */
  absolutePaths: string[];
}

/** Case-folded comparison key, because Windows paths are case-insensitive. */
function keyOf(filePath: string): string {
  const normalized = path.win32.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** `dir/a.JPG` -> `dir/a`, for comparing an output stem to a reference. */
function withoutExtension(filePath: string): string {
  const base = path.win32.basename(filePath);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return path.win32.join(path.win32.dirname(filePath), stem);
}

/**
 * Resolve a reference path. Absolute paths and paths outside the workspace are
 * accepted deliberately: phone uploads land in `.forge/remote-inbox/` and this
 * session's sketches lived under `V:/models/`. The write sandbox is a different
 * exposure and stays where it is.
 */
export function resolveReferencePath(filePath: string, workspaceRoot?: string): string {
  return resolveWorkspacePath(filePath, {
    ...(workspaceRoot ? { workspaceRoot } : {}),
    allowAbsolute: true,
    mustBeInsideWorkspace: false,
  });
}

/**
 * Validate, de-duplicate and resolve the requested reference paths, without
 * touching ffmpeg. Split out so the cap and the de-duplication rule are testable
 * on their own, and so the refusal happens before any process is spawned.
 */
export function resolveReferencePaths(
  requested: readonly unknown[],
  backend: SdcppImageBackendConfig,
  workspaceRoot?: string,
): { paths: string[]; note: string | undefined } {
  const raw = requested.filter(
    (entry): entry is string => typeof entry === 'string' && !!entry.trim(),
  );
  if (raw.length === 0) return { paths: [], note: undefined };

  const seen = new Set<string>();
  const paths: string[] = [];
  let duplicates = 0;
  for (const entry of raw) {
    const absolute = resolveReferencePath(entry.trim(), workspaceRoot);
    const key = keyOf(absolute);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    paths.push(absolute);
  }
  // The cap applies AFTER de-duplication: passing the same file twice must not
  // cost the user a refusal for a request that is really one reference.
  if (paths.length > MAX_REFERENCE_IMAGES) {
    throw new Error(
      `generate_image: ${backend.name} takes at most ${MAX_REFERENCE_IMAGES} reference images; ` +
        `${paths.length} distinct paths were given. Send fewer, or compose them into one picture.`,
    );
  }
  const note =
    duplicates > 0
      ? `${paths.length} reference image(s), ${duplicates} duplicate path removed.`
      : undefined;
  return { paths, note };
}

/**
 * The path `saveImage` will really write, for the collision check. Shares
 * `saveImage`'s resolver so the guard cannot disagree with the write. Returns
 * undefined when it cannot be resolved — `saveImage` reports that failure
 * itself, and the guard must not turn it into a bogus collision message.
 */
export async function resolveOutputForCollision(target: string): Promise<string | undefined> {
  try {
    return await resolveRealWorkspacePath(target, undefined, { allowMissing: true });
  } catch {
    return undefined;
  }
}

/**
 * Read and downscale the references. Runs BEFORE any GPU work, so a bad path, an
 * unsupported format, or a missing ffmpeg costs no render.
 */
export async function prepareLocalReferences(
  backend: SdcppImageBackendConfig,
  requested: readonly unknown[],
  options: {
    workspaceRoot?: string;
    deps: LocalRenderDeps;
    alternatives: readonly string[];
    signal?: AbortSignal;
  },
): Promise<ResolvedReferences | undefined> {
  const { paths, note } = resolveReferencePaths(requested, backend, options.workspaceRoot);
  if (paths.length === 0) return undefined;
  if (!backend.vision_encoder) {
    throw new Error(referenceRefusal(backend, options.alternatives));
  }
  const tools: FfmpegTools = options.deps.ffmpegTools ?? resolveFfmpeg(options.deps.ffmpegPath);
  // Realpath each reference, for two reasons that are one reason: the collision
  // guard must compare the SAME spelling `saveImage` writes with (it resolves
  // through `resolveRealWorkspacePath`, which follows a junction inside the
  // workspace), and two links to one file must collapse into one reference
  // instead of conditioning the render twice. The cap was already applied
  // lexically in `resolveReferencePaths`; resolving links can only reduce the
  // count, so no second cap check lives here.
  const byRealPath = new Map<string, string>();
  for (const entry of paths) {
    try {
      const real = await fs.realpath(entry);
      byRealPath.set(keyOf(real), real);
    } catch {
      // A missing file keeps its lexical path: `prepareReferences` owns the
      // readable refusal for it.
      byRealPath.set(keyOf(entry), entry);
    }
  }
  const resolved = [...byRealPath.values()];
  const prepared = await prepareReferences(resolved, backend.name, {
    maxEdgePx: backend.max_reference_edge_px,
    tools,
    ...(options.deps.runReference ? { run: options.deps.runReference } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.deps.onReferenceSpawn ? { onSpawn: options.deps.onReferenceSpawn } : {}),
  });
  return {
    images: prepared.map((entry) => entry.base64),
    prepared,
    absolutePaths: resolved,
    notes: [...(note ? [note] : []), ...describePreparedReferences(prepared)],
  };
}

/**
 * True when the output would overwrite one of the references. Compared on the
 * extension-stripped path, because the real extension is only known after the
 * render — and the check has to happen before the render.
 */
export function outputCollidesWithReference(
  target: string,
  references: readonly string[],
): string | undefined {
  const targetKey = keyOf(withoutExtension(target));
  for (const reference of references) {
    if (keyOf(withoutExtension(reference)) === targetKey) return reference;
  }
  return undefined;
}

export interface LocalVariationRequest {
  backend: SdcppImageBackendConfig;
  server: Parameters<typeof generateSdcppImage>[0]['server'];
  prompt: string;
  size: unknown;
  seed: number;
  alternatives: readonly string[];
  references?: ResolvedReferences;
  deps: LocalRenderDeps;
  signal?: AbortSignal;
}

export interface LocalVariation {
  bytes: Buffer;
  mime: string;
  seed: number;
  width: number;
  height: number;
  /** Which request shape produced it, reported so the user can tell an edit from a render. */
  mode: 'txt2img' | 'img_gen(ref_images)';
  seconds?: number;
  jobId?: string;
}

/**
 * One variation. Reference edits go through the async job endpoint because that
 * is the only shape measured to condition on a reference; a plain render keeps
 * the shipped synchronous `txt2img` path untouched.
 */
export async function renderLocalVariation(
  request: LocalVariationRequest,
): Promise<LocalVariation> {
  const { width, height } = sdcppSizeFor(request.size, request.backend);
  if (request.references && request.references.images.length > 0) {
    const job = await (request.deps.generateJob ?? runSdcppImageJob)({
      backend: request.backend,
      server: request.server,
      prompt: request.prompt,
      width,
      height,
      seed: request.seed,
      referenceImages: request.references.images,
      alternatives: request.alternatives,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return {
      bytes: job.bytes,
      mime: job.mime,
      seed: job.seed,
      width: job.width,
      height: job.height,
      mode: 'img_gen(ref_images)',
      seconds: job.seconds,
      jobId: job.jobId,
    };
  }
  const image = await (request.deps.generateLocal ?? generateSdcppImage)({
    backend: request.backend,
    server: request.server,
    prompt: request.prompt,
    alternatives: request.alternatives,
    seed: () => request.seed,
    ...(typeof request.size === 'string' ? { size: request.size } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return {
    bytes: image.bytes,
    mime: image.mime,
    seed: image.seed,
    width: image.width,
    height: image.height,
    mode: 'txt2img',
  };
}
