/**
 * The dependencies both media tools share.
 *
 * Every one of them is a real Forge owner, injected rather than re-implemented
 * here: the model lifecycle (loaded models, busy state, `unloadModel`), the
 * window's sd-server handles, the background execution manager and the media
 * GPU lease. The optional fields are the same objects a unit test replaces,
 * which is how the phase 3 tests start no ComfyUI, no GPU job and no network
 * call while still exercising the real lease and unload ordering.
 */
import * as vscode from 'vscode';
import type { ForgeConfig } from '../../config/types';
import type { MediaMusicEngineConfig, MediaVideoEngineConfig } from '../../config/mediaSchema';
import type { SdServerHandle } from '../imageGeneration/sdcppImageBackend';
import { assertDevicesVramAvailable } from '../imageGeneration/sdcppVramGate';
import { acquireMediaGpuLease } from '../../media/mediaGpuLease';
import type { GpuInfo } from '../../system/systemProbes';
import type { BackgroundExecutionManager } from '../BackgroundExecutionManager';
import { probeVideo } from '../videoExtract';
import type { FfmpegTools } from '../ffmpegLocate';
import { renderMediaStill } from './mediaStill';
import type { MediaModelLifecycle } from './mediaGpuFreeing';
import type { MediaRenderDeps } from './mediaRenderRunner';
import type { ToolHandlerContext } from '../ToolRegistry';

export interface MediaToolDeps {
  /** Read live per call, so a config reload changes behaviour with no re-registration. */
  getConfig: () => ForgeConfig;
  /** `<extensionPath>/resources/media`, where the shipped adapters live. */
  adaptersDir: string;
  /** Explicit workspace root; absent falls back to the open workspace folder. */
  workspaceRoot?: string;
  /** The lifecycle seam the tools drive instead of POSTing to a port. */
  lifecycle: MediaModelLifecycle;
  /** The `sd-server` handles `generate_image` dispatches through. */
  sdServers?: () => ReadonlyMap<string, SdServerHandle>;
  /** The model this conversation is generating with, when the context says it. */
  ownModelName?: string;

  /** ── Injectable seams (production uses the real owners) ───────────────── */
  acquireLease?: typeof acquireMediaGpuLease;
  /** Injectable nvidia-smi probe; production uses the shared VRAM gate's probe. */
  gpuProbe?: () => Promise<GpuInfo[]>;
  background?: BackgroundExecutionManager;
  leasePath?: string;
  leasePid?: number;
  leaseProcessStartTime?: number;
  lookupProcessStartTime?: (pid: number) => Promise<number | undefined>;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  idleWaitMs?: number;
  idlePollMs?: number;
  log?: (line: string) => void;
  renderStill?: typeof renderMediaStill;
  /** The source audio's duration, for a music default the user did not set. */
  probeDuration?: (file: string, tools: FfmpegTools) => Promise<number | undefined>;
  ffmpegTools?: FfmpegTools;
  /** Queues the finished file through the existing remote notification/outbox owner. */
  deliverMediaFile?: (event: {
    conversationId: string;
    kind: 'video' | 'audio';
    workspacePath: string;
    previewPath?: string;
    text: string;
  }) => Promise<number>;
}

export async function assertMediaEngineVram(
  deps: MediaToolDeps,
  engine: MediaVideoEngineConfig | MediaMusicEngineConfig,
  request: {
    label: string;
    configKey: string;
    modelPath: string;
    nothingRan: string;
    alternativeMessage: string;
  },
): Promise<void> {
  await assertDevicesVramAvailable({
    ...request,
    deviceConfigKey: `${request.configKey}.cuda_devices`,
    cudaDevices: engine.cuda_devices,
    minFreeVramMb: engine.min_free_vram_mb,
    alternatives: [],
    holdersHint: 'another model or GPU process',
    ...(deps.gpuProbe ? { probe: deps.gpuProbe } : {}),
  });
}

/** The default duration probe: one ffprobe metadata read, no media decoding. */
export async function defaultProbeDuration(
  file: string,
  tools: FfmpegTools,
): Promise<number | undefined> {
  const probe = await probeVideo(tools, file);
  return probe.durationSeconds;
}

/**
 * The workspace root a run folder lands under: the injected one in a test,
 * otherwise the open workspace folder, which is what every path tool and the
 * media setup check fall back to.
 */

export function toolWorkspaceRoot(deps: MediaToolDeps): string {
  const root = deps.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  if (!root) {
    throw new Error(
      'media: no workspace folder is open, so a run folder cannot be created. ' +
        'Open a workspace, or point media.output_dir at an absolute folder.',
    );
  }
  return root;
}

/**
 * Bridge the tool's deps onto the render runner's, so the same injected seams
 * (lease, background manager, timers, log) reach both. Built per call because
 * `exactOptionalPropertyTypes` forbids handing the runner an `undefined` it did
 * not ask for.
 */
export function renderDepsFrom(deps: MediaToolDeps, context?: ToolHandlerContext): MediaRenderDeps {
  return {
    lifecycle: deps.lifecycle,
    ...(context?.modelName
      ? { ownModelName: context.modelName }
      : { ...(deps.ownModelName ? { ownModelName: deps.ownModelName } : {}) }),
    ...(deps.acquireLease ? { acquireLease: deps.acquireLease } : {}),
    ...(deps.background ? { background: deps.background } : {}),
    ...(deps.leasePath ? { leasePath: deps.leasePath } : {}),
    ...(deps.leasePid ? { leasePid: deps.leasePid } : {}),
    ...(deps.leaseProcessStartTime ? { leaseProcessStartTime: deps.leaseProcessStartTime } : {}),
    ...(deps.lookupProcessStartTime ? { lookupProcessStartTime: deps.lookupProcessStartTime } : {}),
    ...(deps.wait ? { wait: deps.wait } : {}),
    ...(deps.idleWaitMs ? { idleWaitMs: deps.idleWaitMs } : {}),
    ...(deps.idlePollMs ? { idlePollMs: deps.idlePollMs } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  };
}
