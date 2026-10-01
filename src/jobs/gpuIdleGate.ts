import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { usesLocalGpu } from '../backend/ModelHeuristics';
import { describeProbeFailure, probeGpus, type GpuInfo } from '../system/systemProbes';
import type { GpuGateConfig, ModelConfig } from '../config/types';
import { getLogger } from '../util/logger';

const GpuHoldSchema = z.object({
  reason: z.string().min(1).optional(),
  pid: z.number().int().positive().optional(),
  until: z.string().datetime({ offset: true }).optional(),
});

interface GpuIdleGateOptions {
  jobsRoot: string;
  model: ModelConfig | undefined;
  gpuGate: GpuGateConfig | undefined;
  loadedModels: () => readonly ModelConfig[];
  signal?: AbortSignal;
  now?: () => number;
  probe?: (signal?: AbortSignal) => Promise<GpuInfo[]>;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  processExists?: (pid: number) => boolean;
}

type HoldResult = { blocked: true; reason: string } | { blocked: false };

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw err;
  }
}

function formatGpuHold(mtimeMs: number, reason: string): string {
  const safeReason = reason.trim().replace(/\s+/gu, ' ') || 'manual';
  return `GPU hold (${safeReason}, since ${new Date(mtimeMs).toISOString()})`;
}

async function readGpuHold(
  jobsRoot: string,
  now: number,
  pidIsRunning: (pid: number) => boolean,
): Promise<HoldResult> {
  const holdPath = path.join(jobsRoot, 'gpu.hold');
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(holdPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { blocked: false };
    return {
      blocked: true,
      reason: `unreadable GPU hold file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(holdPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { blocked: false };
    return {
      blocked: true,
      reason: `unreadable GPU hold file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!raw.trim()) return { blocked: true, reason: formatGpuHold(stat.mtimeMs, 'manual') };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      blocked: true,
      reason: `unreadable GPU hold file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = GpuHoldSchema.safeParse(parsed);
  if (!result.success) {
    return { blocked: true, reason: `unreadable GPU hold file: ${result.error.message}` };
  }

  if (result.data.pid !== undefined) {
    let running: boolean;
    try {
      running = pidIsRunning(result.data.pid);
    } catch (err) {
      return {
        blocked: true,
        reason: `unreadable GPU hold file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!running) {
      const reason = `stale GPU hold from pid ${result.data.pid} ignored`;
      getLogger().info(`[GpuIdleGate] ${reason}`);
      return { blocked: false };
    }
  }
  if (result.data.until !== undefined && Date.parse(result.data.until) <= now) {
    const reason = 'expired GPU hold ignored';
    getLogger().info(`[GpuIdleGate] ${reason}`);
    return { blocked: false };
  }
  return {
    blocked: true,
    reason: formatGpuHold(stat.mtimeMs, result.data.reason ?? 'manual'),
  };
}

function abortError(): Error {
  const err = new Error('GPU probe aborted');
  err.name = 'AbortError';
  return err;
}

function waitOneSecond(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(err: unknown, signal?: AbortSignal): string {
  return signal?.aborted || (err instanceof Error && err.name === 'AbortError')
    ? 'GPU probe aborted'
    : describeProbeFailure(err);
}

async function probeGate(
  options: GpuIdleGateOptions,
  listed: readonly number[],
): Promise<string | undefined> {
  const config = options.gpuGate;
  if (!config) return undefined;
  const probe = options.probe ?? probeGpus;
  const wait = options.wait ?? waitOneSecond;
  const localModelLoaded = options.loadedModels().some(usesLocalGpu);
  for (let sample = 0; sample < config.sample_seconds; sample++) {
    if (options.signal?.aborted) return 'GPU probe aborted';
    let gpus: GpuInfo[];
    try {
      gpus = await probe(options.signal);
    } catch (err) {
      return abortReason(err, options.signal);
    }
    if (options.signal?.aborted) return 'GPU probe aborted';
    for (const index of listed) {
      const gpu = gpus.find((entry) => entry.index === index);
      if (!gpu) return `nvidia-smi returned no row for GPU ${index}`;
      if (gpu.utilizationPercent === null) {
        return `nvidia-smi returned no utilization for GPU ${index}`;
      }
      if (gpu.utilizationPercent > config.max_util_percent) {
        return `GPU ${index} at ${gpu.utilizationPercent}% (limit ${config.max_util_percent}%)`;
      }
      if (!localModelLoaded) {
        if (gpu.memoryUsedMb === null) return `nvidia-smi returned no VRAM usage for GPU ${index}`;
        if (gpu.memoryUsedMb > config.max_idle_vram_mb) {
          return `GPU ${index} has ${gpu.memoryUsedMb} MiB in use by another process (limit ${config.max_idle_vram_mb})`;
        }
      }
    }
    if (sample + 1 < config.sample_seconds) {
      try {
        await wait(1000, options.signal);
      } catch (err) {
        return abortReason(err, options.signal);
      }
    }
  }
  return undefined;
}

/**
 * Decide whether this local-model task may start. The callback runs after the
 * explicit hold and before the expensive sampled probe, preserving admission
 * order without duplicating the existing slot and user-quiet gates.
 */
export async function gpuGateReason(
  options: GpuIdleGateOptions,
  checkCheapGates: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const localGpu = usesLocalGpu(options.model);
  if (localGpu) {
    const hold = await readGpuHold(
      options.jobsRoot,
      (options.now ?? Date.now)(),
      options.processExists ?? processExists,
    );
    if (hold.blocked) return hold.reason;
  }

  const cheapReason = await checkCheapGates();
  if (cheapReason !== undefined) return cheapReason;
  if (!localGpu) return undefined;

  const gpuGate = options.gpuGate;
  if (!gpuGate) return undefined;
  return probeGate(options, gpuGate.gpus);
}
