import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ExecCommandError, spawnAndWait } from '../../util/processSpawn';
import { FfmpegMissingError, type FfmpegTools } from '../ffmpegLocate';
import { mimeFromHeader } from '../imageTool';

/**
 * Reference-image input for a reference-conditioned render: read a user-supplied
 * picture, prove it is an image, and shrink it before it is sent.
 *
 * The shrink is the whole reason this module exists. Measured on this machine:
 * one reference downscaled to 768 px took 3 min; two at full size took 20 min,
 * because the engine ran out of VRAM for its prefix cache and re-streamed the
 * weights on every step. So the resize rule is the highest-value,
 * most-likely-to-regress logic in reference editing, and it lives here where it
 * can be tested without a server, a GPU, or a port.
 *
 * Deliberately free of any `vscode` import: every dependency is Node, so the
 * module is unit-testable outside the extension host. Path resolution and the
 * tool's own voice belong to the caller.
 */

/**
 * Formats the pipeline actually accepts, and therefore the formats a refusal
 * may name. `mimeFromHeader` is the single existing sniffer (PNG, JPEG, GIF,
 * BMP, WEBP) — reused rather than duplicated so the two cannot drift. HEIC and
 * TIFF are not sniffed at all, which is why they land in the refusal.
 */
export const ACCEPTED_REFERENCE_FORMATS = ['PNG', 'JPEG', 'GIF', 'BMP', 'WEBP'] as const;

/** A reference larger than this is refused before any decoding is attempted. */
export const MAX_REFERENCE_INPUT_BYTES = 24 * 1024 * 1024;

/**
 * sd.cpp rejects latent dimensions that are not a multiple of this. Note this
 * differs from `videoExtract.computeScale`'s even-dimension rule: mod-32
 * rounding is new to image editing and has its own tests.
 */
export const DIMENSION_MULTIPLE = 32;

/** One reference decode. A hung ffmpeg must not hang the round. */
export const REFERENCE_DECODE_TIMEOUT_MS = 30_000;

/** Injection seam, mirroring `videoExtract.RunFfmpeg`; tests assert on argv. */
export type RunFfmpeg = (
  bin: string,
  argv: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultRunFfmpeg: RunFfmpeg = async (bin, argv, opts) => {
  const result = await spawnAndWait(bin, argv, path.dirname(bin), opts.timeoutMs, {}, opts.signal);
  return { code: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
};

export interface PreparedReference {
  /** Base64 PNG, the shape the async `ref_images` field takes. */
  base64: string;
  sourcePath: string;
  sourceBytes: number;
  /** Dimensions as read from the file, before any scaling. */
  sourceWidth: number;
  sourceHeight: number;
  /**
   * Dimensions actually sent. `DIMENSION_MULTIPLE` rounding applies only to a
   * reference this module downscaled — a source that already fits the cap is
   * sent at its own dimensions, unrounded, because sd.cpp accepted every size
   * tried in the Phase 0 probes. Do not read this as "always a multiple of 32".
   */
  width: number;
  height: number;
  mime: string;
  /** True when this module changed the pixels. The result must say so. */
  downscaled: boolean;
}

export interface PrepareReferencesOptions {
  /** Longest edge allowed, from config — never a literal in this module. */
  maxEdgePx: number;
  tools: FfmpegTools;
  signal?: AbortSignal;
  run?: RunFfmpeg;
  /** Injectable so a test can prove nothing was spawned for a refused input. */
  onSpawn?: (argv: string[]) => void;
}

/**
 * Longest-edge fit rounded so both dimensions satisfy sd.cpp's mod-32 rule.
 * Returns undefined when the source already fits, exactly like
 * `computeScale`, so the caller can tell "unchanged" from "rescaled".
 */
export function computeReferenceScale(
  width: number,
  height: number,
  maxEdgePx: number,
): { width: number; height: number } | undefined {
  const longest = Math.max(width, height);
  if (longest <= maxEdgePx) return undefined;
  const ratio = maxEdgePx / longest;
  // Floor to the multiple, then clamp up: a 0 or sub-32 dimension is rejected by
  // the engine. Flooring can never push an edge above `maxEdgePx`, and the ratio
  // is < 1 here, so the result never upscales either.
  const fit = (value: number): number =>
    Math.max(
      DIMENSION_MULTIPLE,
      Math.floor((value * ratio) / DIMENSION_MULTIPLE) * DIMENSION_MULTIPLE,
    );
  return { width: fit(width), height: fit(height) };
}

/**
 * ffmpeg argv for one shrink-and-encode pass into `outputPath`. A file, not
 * stdout: `spawnAndWait` decodes stdout as UTF-8 and keeps only its head and
 * tail, so a binary PNG piped there comes back corrupted (the same reason
 * `videoExtract` writes its frames to a temp directory).
 */
export function referenceArgv(
  filePath: string,
  scale: { width: number; height: number } | undefined,
  outputPath: string,
): string[] {
  return [
    // Never inherit stdin: the upstream Windows ffmpeg hang was an unclosed
    // stdin pipe, and Forge does not repeat that shape.
    '-nostdin',
    '-v',
    'error',
    '-i',
    filePath,
    '-frames:v',
    '1',
    ...(scale ? ['-vf', `scale=${scale.width}:${scale.height}:flags=lanczos`] : []),
    // PNG, not JPEG: a reference is conditioning input, and a second lossy
    // encode of an already-lossy phone photo costs detail the edit needs.
    '-vcodec',
    'png',
    '-y',
    outputPath,
  ];
}

/**
 * Parse the width/height ffmpeg reports for the decoded input. Uses ffprobe
 * rather than an ffmpeg stderr regex: the banner format is not a contract.
 */
export function probeImageArgv(filePath: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    filePath,
  ];
}

interface FfprobeImageOutput {
  streams?: { width?: number; height?: number }[];
}

/** A refusal that names the backend, the tool, the failed stage, and the fix. */
function refusal(backend: string, stage: string, detail: string): Error {
  return new Error(
    `generate_image: ${backend}: ${stage} refused a reference image. ${detail} Accepted formats: ` +
      `${ACCEPTED_REFERENCE_FORMATS.join(', ')}. A HEIC or TIFF phone photo must be converted to ` +
      'JPEG or PNG first.',
  );
}

async function readImageDimensions(
  tools: FfmpegTools,
  filePath: string,
  backend: string,
  options: PrepareReferencesOptions,
): Promise<{ width: number; height: number }> {
  const run = options.run ?? defaultRunFfmpeg;
  options.onSpawn?.([tools.ffprobe, ...probeImageArgv(filePath)]);
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await run(tools.ffprobe, probeImageArgv(filePath), {
      timeoutMs: REFERENCE_DECODE_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof ExecCommandError && error.kind === 'missing_executable') {
      throw new FfmpegMissingError(`ffprobe could not be executed at ${tools.ffprobe}.`);
    }
    throw error;
  }
  if (result.code !== 0) {
    throw refusal(
      backend,
      'ffprobe',
      `It could not read ${path.basename(filePath)} — it may not be an image file.`,
    );
  }
  let parsed: FfprobeImageOutput;
  try {
    parsed = JSON.parse(result.stdout) as FfprobeImageOutput;
  } catch {
    throw refusal(
      backend,
      'ffprobe',
      `It returned output that is not JSON for ${path.basename(filePath)}.`,
    );
  }
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw refusal(backend, 'ffprobe', `${path.basename(filePath)} contains no image stream.`);
  }
  return { width: stream.width, height: stream.height };
}

/**
 * Read, validate, and downscale every reference, in order, returning them
 * base64-encoded for the request body.
 *
 * Every refusal happens **before** any GPU work: the caller prepares references
 * before it asks the server for anything, so a bad path, an oversized file, or
 * an unsupported format costs no render.
 */
export async function prepareReferences(
  filePaths: readonly string[],
  backend: string,
  options: PrepareReferencesOptions,
): Promise<PreparedReference[]> {
  const prepared: PreparedReference[] = [];
  let scratch: string | undefined;
  try {
    for (const [index, filePath] of filePaths.entries()) {
      const unreadable = (): Error =>
        new Error(
          `generate_image: ${backend}: reference image "${filePath}" could not be read. Check the path ` +
            'exists; a path outside the workspace is allowed, a path that does not exist is not.',
        );
      // stat first: a directory must be named as one, and an oversized file
      // refused before all of it is read into memory.
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(filePath);
      } catch {
        throw unreadable();
      }
      if (stat.isDirectory()) {
        throw new Error(
          `generate_image: ${backend}: reference image "${filePath}" is a directory. Pass the path ` +
            'of one picture file inside it.',
        );
      }
      const size = Number(stat.size);
      if (size > MAX_REFERENCE_INPUT_BYTES) {
        throw new Error(
          `generate_image: ${backend}: reference image "${path.basename(filePath)}" is ` +
            `${(size / 1024 / 1024).toFixed(1)} MB, over the ` +
            `${(MAX_REFERENCE_INPUT_BYTES / 1024 / 1024).toFixed(0)} MB limit. Send a smaller picture.`,
        );
      }
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(filePath);
      } catch {
        throw unreadable();
      }
      const mime = mimeFromHeader(bytes);
      if (!mime) {
        throw refusal(
          backend,
          'generate_image',
          `"${path.basename(filePath)}" is not a PNG, JPEG, GIF, BMP or WEBP file by its header.`,
        );
      }

      const source = await readImageDimensions(options.tools, filePath, backend, options);
      const scale = computeReferenceScale(source.width, source.height, options.maxEdgePx);
      const run = options.run ?? defaultRunFfmpeg;
      scratch ??= await fs.mkdtemp(path.join(os.tmpdir(), 'forge-reference-'));
      const outputPath = path.join(scratch, `reference-${index}.png`);
      const argv = referenceArgv(filePath, scale, outputPath);
      options.onSpawn?.([tools(options).ffmpeg, ...argv]);

      let result: { code: number; stdout: string; stderr: string };
      try {
        result = await run(tools(options).ffmpeg, argv, {
          timeoutMs: REFERENCE_DECODE_TIMEOUT_MS,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (error instanceof ExecCommandError && error.kind === 'missing_executable') {
          throw new FfmpegMissingError(`ffmpeg could not be executed at ${tools(options).ffmpeg}.`);
        }
        throw error;
      }
      if (result.code !== 0) {
        throw refusal(
          backend,
          'ffmpeg',
          `It failed to decode ${path.basename(filePath)} (exit ${result.code}). ` +
            (result.stderr.trim() ? `It said: ${result.stderr.trim().slice(-300)}` : ''),
        );
      }
      let encoded: Buffer;
      try {
        encoded = await fs.readFile(outputPath);
      } catch {
        throw refusal(
          backend,
          'ffmpeg',
          `It reported success but wrote no image for ${path.basename(filePath)}.`,
        );
      }
      if (encoded.byteLength === 0) {
        throw refusal(
          backend,
          'ffmpeg',
          `It decoded ${path.basename(filePath)} to an empty image.`,
        );
      }
      const outMime = mimeFromHeader(encoded) ?? 'image/png';
      const target = scale ?? source;
      prepared.push({
        base64: encoded.toString('base64'),
        sourcePath: filePath,
        sourceBytes: bytes.byteLength,
        sourceWidth: source.width,
        sourceHeight: source.height,
        width: target.width,
        height: target.height,
        mime: outMime,
        downscaled: scale !== undefined,
      });
    }
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
  return prepared;
}

function tools(options: PrepareReferencesOptions): FfmpegTools {
  return options.tools;
}

/**
 * The sentence the tool result uses to report what this module did. Silent
 * resizing is how a user ends up confused about why detail is missing.
 */
export function describePreparedReferences(prepared: readonly PreparedReference[]): string[] {
  return prepared.map(
    (entry) =>
      `reference ${path.win32.basename(entry.sourcePath)}: ${entry.sourceWidth}x${entry.sourceHeight}` +
      (entry.downscaled
        ? ` downscaled to ${entry.width}x${entry.height} (long edge cap)`
        : ' sent at full size'),
  );
}
