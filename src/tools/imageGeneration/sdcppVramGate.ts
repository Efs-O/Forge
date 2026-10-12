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

/**
 * The gate's subject, once the shape behind the spawn stops being an
 * `sdcpp` backend. `assertVramAvailable` fills these from the backend and
 * keeps its refusal wording byte-identical (tests assert on it); the other
 * caller in this folder — `upscale_image`'s one-shot `sd-cli` — fills the same
 * fields from `image_generation.upscale`. Two copies of a fail-closed gate is
 * how one of them ends up open, so the probe, the GPU lookup and the free-MB
 * arithmetic live here once.
 */
export interface VramGateSubject {
  /** Names the subject at the head of every refusal. */
  label: string;
  /** Config key a refusal points at when the CUDA index does not exist. */
  configKey: string;
  /** CUDA ordinal the spawn would pin with `CUDA_VISIBLE_DEVICES`. */
  cudaDevice: number;
  /** Floor on free memory. Required, never defaulted: a gate that guesses lies. */
  minFreeVramMb: number;
  /** Weights the room is needed for; only the basename is quoted. */
  modelPath: string;
  /** Named in every refusal (refusals name the alternative). */
  alternatives: readonly string[];
  /** Phrase for "nothing ran", lower-case, e.g. `no image was generated`. */
  nothingRan: string;
  /** What to stop, named in the too-little-VRAM refusal. */
  holdersHint: string;
  /** Injectable: the real probe spawns nvidia-smi. */
  probe?: () => Promise<GpuInfo[]>;
}

export async function assertVramAvailable(request: VramGateRequest): Promise<void> {
  const { backend, alternatives } = request;
  await assertDeviceVramAvailable({
    label: backend.name,
    configKey: `image_generation.backends.${backend.name}`,
    cudaDevice: backend.cuda_device,
    minFreeVramMb: backend.min_free_vram_mb,
    modelPath: backend.diffusion_model,
    alternatives,
    nothingRan: 'no image was generated',
    holdersHint: 'whisper, a mmproj, another server',
    ...(request.probe ? { probe: request.probe } : {}),
  });
}

/** The gate itself. See `VramGateSubject` for what each field is for. */
export async function assertDeviceVramAvailable(subject: VramGateSubject): Promise<void> {
  const { label, configKey, cudaDevice, minFreeVramMb, alternatives, nothingRan } = subject;
  let gpus: GpuInfo[];
  try {
    gpus = await (subject.probe ?? probeGpus)();
  } catch (error) {
    throw new Error(
      `${label}: could not check free VRAM on CUDA device ${cudaDevice} ` +
        `(${describeProbeFailure(error)}), so ${nothingRan}. Fix the probe, or use ` +
        `${alternativeText(alternatives)}.`,
    );
  }
  const gpu = gpus.find((entry) => entry.index === cudaDevice);
  if (!gpu) {
    const seen =
      gpus.map((entry) => `${entry.index} (${entry.name})`).join(', ') || 'no GPUs at all';
    throw new Error(
      `${label}: nvidia-smi reported ${seen}, so there is no GPU at index ` +
        `${cudaDevice}. Set ${configKey}.cuda_device to one of them, or use ` +
        `${alternativeText(alternatives)}.`,
    );
  }
  if (gpu.memoryTotalMb === null || gpu.memoryUsedMb === null) {
    const sentence = `${nothingRan.charAt(0).toUpperCase()}${nothingRan.slice(1)}`;
    throw new Error(
      `${label}: nvidia-smi gave no memory figures for GPU ${gpu.index} (${gpu.name}), so Forge ` +
        `cannot tell whether ${minFreeVramMb.toLocaleString()} MB is free. ${sentence}; use ` +
        `${alternativeText(alternatives)}.`,
    );
  }
  const free = gpu.memoryTotalMb - gpu.memoryUsedMb;
  if (free < minFreeVramMb) {
    throw new Error(
      `${label}: only ${free.toLocaleString()} MB free on GPU ${gpu.index} (${gpu.name}); ` +
        `${minFreeVramMb.toLocaleString()} MB is required to load ` +
        `"${path.win32.basename(subject.modelPath)}". Stop whatever holds that card ` +
        `(${subject.holdersHint}) or use ${alternativeText(alternatives)}.`,
    );
  }
}
