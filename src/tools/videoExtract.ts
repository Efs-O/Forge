import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ExecCommandError, spawnAndWait } from '../util/processSpawn';
import { FfmpegMissingError, type FfmpegTools } from './ffmpegLocate';

export { FfmpegMissingError, resolveFfmpeg, type FfmpegTools } from './ffmpegLocate';

/**
 * ffmpeg discovery, probing and frame extraction for `view_video`.
 *
 * Deliberately free of any `vscode` import: every dependency here is Node, so
 * the module is unit-testable outside the extension host. Path containment and
 * workspace resolution belong to `videoTool.ts`, which is the vscode-aware half.
 */

/** Injection seam. The real runner shells out; tests assert on `argv`. */
export type RunFfmpeg = (
  bin: string,
  argv: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultRunFfmpeg: RunFfmpeg = async (bin, argv, opts) => {
  const result = await spawnAndWait(bin, argv, path.dirname(bin), opts.timeoutMs, {}, opts.signal);
  return { code: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
};

export interface VideoProbe {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

// ── probe ────────────────────────────────────────────────────────────────────

/** ffprobe is a metadata read; a clip that needs longer than this is pathological. */
export const PROBE_TIMEOUT_MS = 20_000;

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

function parseSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Last few lines of stderr — enough to diagnose, short enough not to flood context. */
export function tailOf(stderr: string, maxChars = 400): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `…${trimmed.slice(-maxChars)}`;
}

/**
 * One ffprobe call for all streams plus the container. JSON, never a stderr
 * regex: the `Duration:` scrape used by the reference implementation breaks on
 * any ffmpeg build that reworks its banner.
 */
export async function probeVideo(
  tools: FfmpegTools,
  file: string,
  signal?: AbortSignal,
  run: RunFfmpeg = defaultRunFfmpeg,
): Promise<VideoProbe> {
  const argv = [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,width,height,duration',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    file,
  ];

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await run(tools.ffprobe, argv, {
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof ExecCommandError && error.kind === 'missing_executable') {
      throw new FfmpegMissingError(`ffprobe could not be executed at ${tools.ffprobe}.`);
    }
    throw error;
  }

  if (result.code !== 0) {
    throw new Error(
      `view_video: ffprobe could not read ${path.basename(file)} — it may not be a video file. ${tailOf(result.stderr)}`,
    );
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(result.stdout) as FfprobeOutput;
  } catch {
    throw new Error(
      `view_video: ffprobe returned output that is not JSON for ${path.basename(file)}.`,
    );
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video || !video.width || !video.height) {
    throw new Error(
      `view_video: ${path.basename(file)} contains no video stream. Use view_image for still images.`,
    );
  }

  // Container duration first: per-stream duration is routinely absent in MP4.
  const duration = parseSeconds(parsed.format?.duration) ?? parseSeconds(video.duration);
  if (duration === undefined) {
    throw new Error(
      `view_video: could not determine the duration of ${path.basename(file)}; the file may be truncated.`,
    );
  }

  return {
    durationSeconds: duration,
    width: video.width,
    height: video.height,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
  };
}

// ── frame extraction ─────────────────────────────────────────────────────────

/** A single ffmpeg frame decode. Generous, but bounded: a hung ffmpeg must not hang the round. */
export const FRAME_TIMEOUT_MS = 30_000;

/** Backstop on the summed base64, mirroring MAX_VIEW_IMAGE_BYTES for a single image. */
export const MAX_VIDEO_FRAMES_BYTES = 12 * 1024 * 1024;

/** Never sample the final moments: the last frame is often a fade or a cut. */
const END_GUARD_SECONDS = 0.12;

/** Below this many seconds per frame the samples stop telling you anything new. */
const SECONDS_PER_FRAME = 5;
const MIN_FRAMES = 3;

export interface VideoOptions {
  maxFrames: number;
  frameMaxDimension: number;
  frameQuality: number;
  maxDurationSeconds: number;
}

export interface ExtractedFrame {
  jpegBase64: string;
  timeSeconds: number;
}

export interface VideoExtraction {
  frames: ExtractedFrame[];
  probe: VideoProbe;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * How many stills to take. Tied to duration so a 3 s clip is not sampled as
 * densely as a 30 s one, and hard-bounded by the caller's cap because frames
 * are the dominant term in prompt cost.
 */
export function frameCountFor(durationSeconds: number, maxFrames: number): number {
  const cap = Math.max(1, Math.floor(maxFrames));
  return clamp(Math.round(durationSeconds / SECONDS_PER_FRAME), Math.min(MIN_FRAMES, cap), cap);
}

/**
 * Centre of each slice, not its boundary. Sampling at boundaries lands on cuts
 * and transitions; the centre lands on the shot the slice is actually about.
 */
export function frameTimes(durationSeconds: number, count: number): number[] {
  const last = Math.max(0, durationSeconds - END_GUARD_SECONDS);
  return Array.from({ length: count }, (_unused, index) =>
    clamp(durationSeconds * ((index + 0.5) / count), 0, last),
  );
}

/**
 * Target size, or undefined when the source already fits. Computed here rather
 * than delegated to an ffmpeg expression so the argv is deterministic and the
 * scaling decision is directly testable.
 */
export function computeScale(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } | undefined {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return undefined;
  const ratio = maxDimension / longest;
  const even = (value: number): number => Math.max(2, Math.round((value * ratio) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** The argv for one frame. Exported so tests assert the contract without ffmpeg. */
export function frameArgv(
  file: string,
  timeSeconds: number,
  outputPath: string,
  probe: VideoProbe,
  options: VideoOptions,
): string[] {
  const scale = computeScale(probe.width, probe.height, options.frameMaxDimension);
  return [
    // Never inherit stdin. The upstream Windows video hang was a stdin pipe
    // that was never closed; Forge does not repeat that shape.
    '-nostdin',
    '-v',
    'error',
    // Input seeking: -ss before -i so ffmpeg jumps rather than decoding forward.
    '-ss',
    timeSeconds.toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-update',
    '1',
    ...(scale ? ['-vf', `scale=${scale.width}:${scale.height}:flags=lanczos`] : []),
    '-q:v',
    String(options.frameQuality),
    '-f',
    'image2',
    '-y',
    outputPath,
  ];
}

/**
 * Sample `frameCountFor()` stills across the clip and return them base64-encoded
 * in time order. The temp directory is removed on both success and failure.
 */
export async function extractFrames(
  tools: FfmpegTools,
  file: string,
  probe: VideoProbe,
  options: VideoOptions,
  signal?: AbortSignal,
  run: RunFfmpeg = defaultRunFfmpeg,
): Promise<VideoExtraction> {
  if (probe.durationSeconds > options.maxDurationSeconds) {
    throw new Error(
      `view_video: ${path.basename(file)} is ${probe.durationSeconds.toFixed(1)}s, longer than the ` +
        `${options.maxDurationSeconds}s limit. Trim the clip, or raise video.max_duration_seconds ` +
        'in Forge config — note that every extra frame costs prompt tokens.',
    );
  }

  const count = frameCountFor(probe.durationSeconds, options.maxFrames);
  const times = frameTimes(probe.durationSeconds, count);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-video-'));
  try {
    const frames: ExtractedFrame[] = [];
    let totalBytes = 0;
    for (const [index, timeSeconds] of times.entries()) {
      const outputPath = path.join(dir, `frame-${String(index).padStart(3, '0')}.jpg`);
      const argv = frameArgv(file, timeSeconds, outputPath, probe, options);

      let result: { code: number; stdout: string; stderr: string };
      try {
        result = await run(tools.ffmpeg, argv, {
          timeoutMs: FRAME_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (error instanceof ExecCommandError && error.kind === 'missing_executable') {
          throw new FfmpegMissingError(`ffmpeg could not be executed at ${tools.ffmpeg}.`);
        }
        throw error;
      }
      if (result.code !== 0) {
        throw new Error(
          `view_video: ffmpeg failed extracting the frame at ${timeSeconds.toFixed(2)}s. ${tailOf(result.stderr)}`,
        );
      }

      let bytes: Buffer;
      try {
        bytes = await fsp.readFile(outputPath);
      } catch {
        throw new Error(
          `view_video: ffmpeg reported success but wrote no frame at ${timeSeconds.toFixed(2)}s.`,
        );
      }

      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_VIDEO_FRAMES_BYTES) {
        // Fail loudly rather than returning a truncated set: half a frame
        // sequence is worse than none, because the model reasons over it anyway.
        throw new Error(
          `view_video: extracted frames exceed ${(MAX_VIDEO_FRAMES_BYTES / 1024 / 1024).toFixed(0)} MB. ` +
            'Lower video.frame_max_dimension or video.max_frames.',
        );
      }
      frames.push({ jpegBase64: bytes.toString('base64'), timeSeconds });
    }
    return { frames, probe };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
