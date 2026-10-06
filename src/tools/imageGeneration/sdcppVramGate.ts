import * as path from 'path';
import type { SdcppImageBackendConfig } from '../../config/types';
import { describeProbeFailure, probeGpus, type GpuInfo } from '../../system/systemProbes';
import { alternativeText } from './sdcppErrors';

/**
 * The VRAM gate, shared by both `sd-server` request shapes.
 *
 * Refuse before anything is loaded when the configured card cannot hold the
 * model. Fails closed: a probe that cannot see the GPU never waves a render
 * through — the same rule `JOB_GPU_GATE_PLAN.md` states for scheduled jobs.
 *
 * Owned here rather than inside `sdcppImageBackend.ts` because the gate belongs
 * to the *spawn*, and the spawn can now be reached by two callers (the sync
 * `txt2img` render and the async `img_gen` job). Two copies of a fail-closed
 * gate is how one of them ends up open.
 */
export interface VramGateRequest {
  backend: SdcppImageBackendConfig;
  /** Named in every refusal (refusals name the alternative). */
  alternatives: readonly string[];
  /** Injectable: the real probe spawns nvidia-smi. */
  probe?: () => Promise<GpuInfo[]>;
}

export async function assertVramAvailable(request: VramGateRequest): Promise<void> {
  const { backend, alternatives } = request;
  const key = `image_generation.backends.${backend.name}`;
  let gpus: GpuInfo[];
  try {
    gpus = await (request.probe ?? probeGpus)();
  } catch (error) {
    throw new Error(
      `${backend.name}: could not check free VRAM on CUDA device ${backend.cuda_device} ` +
        `(${describeProbeFailure(error)}), so no image was generated. Fix the probe, or use ` +
        `${alternativeText(alternatives)}.`,
    );
  }
  const gpu = gpus.find((entry) => entry.index === backend.cuda_device);
  if (!gpu) {
    const seen =
      gpus.map((entry) => `${entry.index} (${entry.name})`).join(', ') || 'no GPUs at all';
    throw new Error(
      `${backend.name}: nvidia-smi reported ${seen}, so there is no GPU at index ` +
        `${backend.cuda_device}. Set ${key}.cuda_device to one of them, or use ` +
        `${alternativeText(alternatives)}.`,
    );
  }
  if (gpu.memoryTotalMb === null || gpu.memoryUsedMb === null) {
    throw new Error(
      `${backend.name}: nvidia-smi gave no memory figures for GPU ${gpu.index} (${gpu.name}), so Forge ` +
        `cannot tell whether ${backend.min_free_vram_mb.toLocaleString()} MB is free. No image was ` +
        `generated; use ${alternativeText(alternatives)}.`,
    );
  }
  const free = gpu.memoryTotalMb - gpu.memoryUsedMb;
  if (free < backend.min_free_vram_mb) {
    throw new Error(
      `${backend.name}: only ${free.toLocaleString()} MB free on GPU ${gpu.index} (${gpu.name}); ` +
        `${backend.min_free_vram_mb.toLocaleString()} MB is required to load ` +
        `"${path.win32.basename(backend.diffusion_model)}". Stop whatever holds that card (whisper, a ` +
        `mmproj, another server) or use ${alternativeText(alternatives)}.`,
    );
  }
}
