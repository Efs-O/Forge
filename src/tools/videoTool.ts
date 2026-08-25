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
  maxFrames: 8,
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
 * The tool argument may only *lower* the configured cap. A model that can raise
 * it can talk itself into a 20k-token prompt, which is the failure the whole
 * design exists to avoid.
 */
export function applyRequestedFrameCap(options: VideoOptions, requested: unknown): VideoOptions {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return options;
  const floored = Math.floor(requested);
  if (floored < 1) return options;
  return { ...options, maxFrames: Math.min(options.maxFrames, floored) };
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
): string {
  const at = times.map((time) => `${time.toFixed(1)}s`).join(', ');
  return (
    `Video ${relativePath} — ${probe.durationSeconds.toFixed(1)}s, ${probe.width}x${probe.height}. ` +
    `${times.length} still frame${times.length === 1 ? '' : 's'} sampled at ${at}. ` +
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
                'Sample at most this many frames. May only lower the configured limit, never ' +
                'raise it. Fewer frames cost fewer prompt tokens.',
              minimum: 1,
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

      const options = applyRequestedFrameCap(
        resolveVideoOptions(getVideoConfig?.()),
        args['max_frames'],
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
