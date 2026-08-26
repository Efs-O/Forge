import * as path from 'path';
import * as vscode from 'vscode';
import type { VideoConfig } from '../config/types';
import type { ContentPart } from '../llm/types';
import { resolveRealWorkspacePath } from '../util/WorkspacePaths';
import { extractFrames, probeVideo, resolveFfmpeg, type VideoOptions } from './videoExtract';
import type { MultimodalToolResult, RegisteredTool } from './ToolRegistry';

/**
 * Defaults for the `video:` config block. Written down here and nowhere else —
 * `frame_max_dimension` is a context knob before it is a quality one: measured
 * on one 5 s clip against Qwen3.8-27B, unscaled 1920x1088 costs 22,501 prompt
 * tokens (rejected at 16k ctx), 640 px costs 2,479, and 384 px costs 983.
 */
export const VIDEO_DEFAULTS: VideoOptions = {
  maxDurationSeconds: 30,
  // 26, not 8: short music-video clips land on the 3-frame duration floor, and
  // the ceiling's job is to stop a 30 s clip blowing a 16k context — not to
  // ration frames on a 10 s one.
  maxFrames: 26,
  frameMaxDimension: 640,
  frameQuality: 3,
};

/** Containers ffmpeg reads that a user is plausibly pointing us at. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v']);

/**
 * Why `view_video` is unavailable on a model without a projector. Mirrors
 * `visionUnavailableMessage`: a bare "unknown tool" taught the agent the
 * capability did not exist, and it went looking for a workaround.
 */
export function videoUnavailableMessage(modelName: string): string {
  return (
    `Error: view_video is not available because the active model "${modelName}" has no vision ` +
    'projector configured (mmproj_path). Do not try to read the video with another tool: ' +
    'report that you cannot see it and ask the user to switch to a vision-capable model.'
  );
}

export function resolveVideoOptions(config: VideoConfig | undefined): VideoOptions {
  return {
    maxDurationSeconds: config?.max_duration_seconds ?? VIDEO_DEFAULTS.maxDurationSeconds,
    maxFrames: config?.max_frames ?? VIDEO_DEFAULTS.maxFrames,
    frameMaxDimension: config?.frame_max_dimension ?? VIDEO_DEFAULTS.frameMaxDimension,
    frameQuality: config?.frame_quality ?? VIDEO_DEFAULTS.frameQuality,
  };
}

/**
 * Record the caller's explicit frame count. It is honoured exactly, up to the
 * configured ceiling — which still bounds prompt cost, the thing the design
 * actually cares about.
 *
 * An earlier version lowered `maxFrames` instead. That looked equivalent and
 * was not: the count is normally derived from duration, and on any clip under
 * ~40 s the heuristic already sits at or below the cap, so lowering the cap
 * changed nothing. Asking for 10 frames on an 11 s clip returned 3, with
 * nothing in the result explaining why.
 */
export function applyRequestedFrameCount(options: VideoOptions, requested: unknown): VideoOptions {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return options;
  const floored = Math.floor(requested);
  if (floored < 1) return options;
  return { ...options, requestedFrames: floored };
}

/** Bounds mirror the config schema, so a tool arg can never reach a value the config would reject. */
const MIN_FRAME_DIMENSION = 64;
const MAX_FRAME_DIMENSION = 4096;

/**
 * Per-call resolution override. Clamped rather than rejected: a model asking
 * for 8000 px wants "as much detail as you have", and failing the whole call
 * over it costs a round for nothing.
 */
export function applyRequestedDimension(options: VideoOptions, requested: unknown): VideoOptions {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return options;
  const clamped = Math.min(
    MAX_FRAME_DIMENSION,
    Math.max(MIN_FRAME_DIMENSION, Math.floor(requested)),
  );
  return { ...options, frameMaxDimension: clamped };
}

/**
 * Per-call time window. Validation of the pair against the clip belongs to
 * `resolveWindow`, which has the probe; this only records what was asked.
 */
export function applyRequestedWindow(
  options: VideoOptions,
  start: unknown,
  end: unknown,
): VideoOptions {
  const next = { ...options };
  if (typeof start === 'number' && Number.isFinite(start)) next.startSeconds = start;
  if (typeof end === 'number' && Number.isFinite(end)) next.endSeconds = end;
  return next;
}

function workspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('view_video: no workspace folder is open.');
  return root;
}

/**
 * Summary line the model reads before the frames. The "stills, not motion"
 * clause is load bearing: without it the model narrates action between samples
 * as though it had watched them.
 */
export function summaryLine(
  relativePath: string,
  probe: { durationSeconds: number; width: number; height: number },
  times: number[],
  options?: VideoOptions,
): string {
  const at = times.map((time) => `${time.toFixed(1)}s`).join(', ');
  const requested = options?.requestedFrames;
  // State the window explicitly. Otherwise a windowed result is indistinguishable
  // from a short clip, and the model reasons about the wrong span of time.
  const start = options?.startSeconds;
  const end = options?.endSeconds;
  const windowed =
    (start !== undefined && start > 0) || (end !== undefined && end < probe.durationSeconds)
      ? ` Sampled only ${(start ?? 0).toFixed(1)}s-${(end ?? probe.durationSeconds).toFixed(1)}s of the clip, not all of it.`
      : '';
  // Say why the count is what it is. Without this a caller whose request was
  // clipped has to infer the reason, and the obvious inference is wrong.
  const why =
    requested !== undefined && requested > times.length
      ? ` You asked for ${requested}; ${times.length} is the configured ceiling (video.max_frames).`
      : requested === undefined
        ? ' Count was chosen from the clip length; pass max_frames to sample more densely.'
        : '';
  return (
    `Video ${relativePath} — ${probe.durationSeconds.toFixed(1)}s, ${probe.width}x${probe.height}. ` +
    `${times.length} still frame${times.length === 1 ? '' : 's'} sampled at ${at}.${windowed}${why} ` +
    'These are stills, not motion: you cannot see what happens between them, and you have no audio.'
  );
}

export function makeViewVideoTool(getVideoConfig?: () => VideoConfig | undefined): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'view_video',
        description:
          'Load and inspect a short video from the workspace. Returns a small set of still ' +
          'frames sampled evenly across the clip, in time order — you do NOT receive the video ' +
          'itself, its motion, or its audio. The path must be workspace-relative or absolute ' +
          'inside the workspace. Supported: MP4, WebM, MOV, MKV, AVI, M4V. Requires ffmpeg.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Video path relative to the workspace root or an absolute path inside it.',
            },
            max_frames: {
              type: 'integer',
              description:
                'How many frames to sample. Omit and the count is chosen from the clip length ' +
                '(roughly one frame per 5 seconds, minimum 3), which is sparse for a short ' +
                'clip — an 11-second clip gets 3. Pass a number to sample more densely; it is ' +
                'honoured exactly unless it exceeds the configured ceiling, in which case you ' +
                'get the ceiling. Each extra frame costs prompt tokens.',
              minimum: 1,
            },
            frame_max_dimension: {
              type: 'integer',
              description:
                'Longest edge of each frame in pixels (default 640). Raise it when detail in ' +
                'the frame is too small to read — on-screen text, a face, fine texture. Cost ' +
                'rises steeply: 640 costs roughly 2.5x what 384 does. Lower it to fit a small ' +
                'context.',
              minimum: 64,
              maximum: 4096,
            },
            start_seconds: {
              type: 'number',
              description:
                'Sample only from this point onward. Use with end_seconds to concentrate frames ' +
                'on the part of the clip you care about instead of spreading them over the whole ' +
                'thing. Defaults to the start of the clip.',
              minimum: 0,
            },
            end_seconds: {
              type: 'number',
              description:
                'Stop sampling at this point. Defaults to the end of the clip. Values past the ' +
                'end are clamped, not rejected.',
              exclusiveMinimum: 0,
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args, context): Promise<MultimodalToolResult> => {
      const requestedPath = args['path'];
      if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
        throw new Error('view_video: path must be a non-empty string.');
      }

      const root = workspaceRoot();
      // Canonical containment (realpath + isPathInside). Do not add a second check.
      const file = await resolveRealWorkspacePath(requestedPath, root);
      const extension = path.extname(file).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(extension)) {
        throw new Error(
          `view_video: ${extension || 'that file'} is not a supported video container. ` +
            'Use MP4, WebM, MOV, MKV, AVI, or M4V — or view_image for a still image.',
        );
      }

      // Config supplies the baseline; each tool argument overrides one field.
      const options = applyRequestedWindow(
        applyRequestedDimension(
          applyRequestedFrameCount(resolveVideoOptions(getVideoConfig?.()), args['max_frames']),
          args['frame_max_dimension'],
        ),
        args['start_seconds'],
        args['end_seconds'],
      );
      const tools = resolveFfmpeg(getVideoConfig?.()?.ffmpeg_path);
      const signal = context?.abortSignal;
      const probe = await probeVideo(tools, file, signal);
      const extraction = await extractFrames(tools, file, probe, options, signal);

      const relative = path.relative(root, file) || path.basename(file);
      const text = summaryLine(
        relative,
        probe,
        extraction.frames.map((frame) => frame.timeSeconds),
        options,
      );

      // A text label before each frame is what lets the model reason about
      // ordering and elapsed time instead of treating the set as an unordered
      // bag of pictures.
      const content: ContentPart[] = [{ type: 'text', text }];
      for (const [index, frame] of extraction.frames.entries()) {
        content.push({
          type: 'text',
          text: `Frame ${index + 1} of ${extraction.frames.length} — t=${frame.timeSeconds.toFixed(1)}s`,
        });
        content.push({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${frame.jpegBase64}` },
        });
      }
      return { text, content };
    },
  };
}
