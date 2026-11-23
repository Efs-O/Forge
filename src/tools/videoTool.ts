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
    `Error: view_video needs a vision model; the active model "${modelName}" is not configured ` +
    'for vision (llama.cpp: set mmproj_path; other providers: declare the vision capability). ' +
    'Do not try to read the video with another tool: ' +
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
 * An earlier version lowered `maxFrames` instead. That only changed the
 * ceiling; it did not record the caller's requested count for the extractor.
 */
export function applyRequestedFrameCount(options: VideoOptions, requested: unknown): VideoOptions {
  if (requested === undefined) return options;
  if (
    typeof requested !== 'number' ||
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > options.maxFrames
  ) {
    throw new Error(`view_video: "max_frames" must be an integer from 1 to ${options.maxFrames}.`);
  }
  return { ...options, requestedFrames: requested };
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
  if (requested === undefined) return options;
  if (
    typeof requested !== 'number' ||
    !Number.isInteger(requested) ||
    requested < MIN_FRAME_DIMENSION ||
    requested > MAX_FRAME_DIMENSION
  ) {
    throw new Error(
      `view_video: "frame_max_dimension" must be an integer from ${MIN_FRAME_DIMENSION} to ${MAX_FRAME_DIMENSION}.`,
    );
  }
  return { ...options, frameMaxDimension: requested };
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
  if (start !== undefined) {
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) {
      throw new Error(
        'view_video: "start_seconds" must be a finite number from 0 to the clip duration.',
      );
    }
    next.startSeconds = start;
  }
  if (end !== undefined) {
    if (typeof end !== 'number' || !Number.isFinite(end) || end <= 0) {
      throw new Error('view_video: "end_seconds" must be a finite number greater than 0.');
    }
    next.endSeconds = end;
  }
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
  // State the window explicitly. Otherwise a windowed result is indistinguishable
  // from a short clip, and the model reasons about the wrong span of time.
  // The end is clamped to the clip as `resolveWindow` clamps it, so an
  // end_seconds past the end is reported as the span actually sampled.
  const start = options?.startSeconds ?? 0;
  const requestedEnd = options?.endSeconds;
  const end = Math.min(requestedEnd ?? probe.durationSeconds, probe.durationSeconds);
  const pastEnd =
    requestedEnd !== undefined && requestedEnd > probe.durationSeconds
      ? ` requested end ${requestedEnd.toFixed(1)} s, clip ends at ${probe.durationSeconds.toFixed(1)} s.`
      : '';
  const windowed =
    start > 0 || end < probe.durationSeconds
      ? ` Sampled only ${start.toFixed(1)}s-${end.toFixed(1)}s of the clip, not all of it.`
      : '';
  return (
    `Video ${relativePath} — ${probe.durationSeconds.toFixed(1)}s, ${probe.width}x${probe.height}. ` +
    `${times.length} still frame${times.length === 1 ? '' : 's'} sampled at ${at}.${windowed}${pastEnd} ` +
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
          'itself, its motion, or its audio. Needs a vision model; on a text-only model report ' +
          'that you cannot inspect the frames and ask the user to switch models. The path must ' +
          'be workspace-relative or absolute ' +
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
              minimum: 1,
              description:
                'How many frames to sample. Omit and Forge samples about one frame per second, ' +
                'with a minimum of 4 and maximum of 10, clamped by video.max_frames. Pass a ' +
                'number to choose more or fewer when you need a different count; explicit ' +
                'requests are honoured from 1 up to video.max_frames ' +
                `(default ${VIDEO_DEFAULTS.maxFrames}). Each extra frame costs prompt tokens.`,
            },
            frame_max_dimension: {
              type: 'integer',
              minimum: MIN_FRAME_DIMENSION,
              maximum: MAX_FRAME_DIMENSION,
              description:
                'Longest edge of each frame in pixels (default 640). Raise it when detail in ' +
                'the frame is too small to read — on-screen text, a face, fine texture. Cost ' +
                'rises steeply: 640 costs roughly 2.5x what 384 does. Lower it to fit a small ' +
                'context.',
            },
            start_seconds: {
              type: 'number',
              minimum: 0,
              description:
                'Sample only from this point onward. Use with end_seconds to concentrate frames ' +
                'on the part of the clip you care about instead of spreading them over the whole ' +
                'thing. Defaults to the start of the clip.',
            },
            end_seconds: {
              type: 'number',
              exclusiveMinimum: 0,
              description:
                'Stop sampling at this point. Omit it to use the clip end; values after the end are reported.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    requiresVision: (name) => videoUnavailableMessage(name),
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
