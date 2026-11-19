/**
 * The tool instances a remote media job runs, and the path arguments it is allowed
 * to name. Split from `remoteMediaJobs.ts` by the 500-line gate and by the concern:
 * the queue, the standing-consent gate and the sweep live there; these two sections
 * read only `deps` and the request, so they move whole. The class keeps calling them.
 */
import { makeGenerateImageTool } from '../tools/imageGeneration/generateImageTool';
import { makeUpscaleImageTool } from '../tools/imageGeneration/upscaleImageTool';
import type { RegisteredTool } from '../tools/ToolRegistry';
import {
  REMOTE_MEDIA_PATH_ARGS,
  REMOTE_MEDIA_TEXT,
  type RemoteMediaJobRequest,
  type RemoteMediaTool,
} from './remoteMediaContract';
import { JobNotifier, isPlainRelative, type Job } from './remoteMediaJobStore';
import type { RemoteMediaJobsDeps } from './remoteMediaJobs';

// ── Job-scoped tool instances ───────────────────────────────────────────────

/**
 * A FRESH instance per job, with the job's own root as its workspace root, a
 * reveal that opens no desktop editor tab, and the window's real `sd-server`
 * handles, so a laptop render keeps one server warm for the desktop chats too.
 */
export function jobToolFor(
  deps: RemoteMediaJobsDeps,
  job: Job,
  record: (absolutePath: string) => void,
): RegisteredTool {
  return job.tool === 'upscale_image'
    ? // `upscale_image` names its output beside the input and refuses a path
      // outside `workspaceRoot`, so its root is the job folder, not `out/`.
      upscaleToolFor(deps, job.dir, record)
    : imageToolFor(deps, job.outDir, record);
}

export function imageToolFor(
  deps: RemoteMediaJobsDeps,
  workspaceRoot: string,
  record: (path: string) => void,
): RegisteredTool {
  return makeGenerateImageTool({
    getConfig: deps.getConfig,
    secrets: deps.secrets,
    notifications: new JobNotifier(record),
    ...(deps.sdServers ? { sdServers: deps.sdServers } : {}),
    workspaceRoot,
    reveal: async () => undefined,
    ...deps.imageDeps,
  });
}

export function upscaleToolFor(
  deps: RemoteMediaJobsDeps,
  workspaceRoot: string,
  record: (path: string) => void,
): RegisteredTool {
  return makeUpscaleImageTool({
    getConfig: deps.getConfig,
    notifications: new JobNotifier(record),
    workspaceRoot,
    ...deps.upscaleDeps,
  });
}

// ── Path arguments ──────────────────────────────────────────────────────────

/**
 * Apply `REMOTE_MEDIA_PATH_ARGS` and rewrite what passes.
 *
 * An input argument's value must be the bare name of an uploaded input, and
 * becomes a path inside the job; an output argument must be a plain relative
 * path. Nothing else is accepted, so a refusal reads no desktop file.
 */
export function rewritePathArgs(
  request: RemoteMediaJobRequest,
): { ok: true; args: Record<string, unknown> } | { ok: false; text: string } {
  const args = { ...request.args };
  const uploaded = new Set((request.inputs ?? []).map((input) => input.name));
  for (const [arg, direction] of Object.entries(REMOTE_MEDIA_PATH_ARGS[request.tool])) {
    const value = args[arg];
    if (value === undefined) continue;
    if (direction === 'output') {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text || !isPlainRelative(text)) {
        return { ok: false, text: REMOTE_MEDIA_TEXT.outputRefused(arg) };
      }
      continue;
    }
    if (direction === 'input-list') {
      const names = Array.isArray(value) ? value : [];
      if (!names.every((name) => typeof name === 'string' && uploaded.has(name))) {
        return { ok: false, text: REMOTE_MEDIA_TEXT.pathRefused(arg) };
      }
      args[arg] = names.map((name) => inputLink(request.tool, name as string));
      continue;
    }
    const name = typeof value === 'string' ? value.trim() : '';
    if (!uploaded.has(name)) return { ok: false, text: REMOTE_MEDIA_TEXT.pathRefused(arg) };
    args[arg] = inputLink(request.tool, name);
  }
  return { ok: true, args };
}

/**
 * How an uploaded input is named from the root that tool resolves against.
 *
 * `generate_image` gets `out/` as its root (the plan's choice), so its inputs
 * sit one level up. `upscale_image` cannot: its output name is derived beside
 * the input, so its root is the job folder and the input needs no `..`.
 */
function inputLink(tool: RemoteMediaTool, name: string): string {
  return tool === 'upscale_image' ? `inputs/${name}` : `../inputs/${name}`;
}
