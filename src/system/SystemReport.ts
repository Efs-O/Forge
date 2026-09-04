/**
 * Canonical owner of Forge's machine report: what the GPUs, RAM and drives are
 * doing, and — the part no external tool can answer — which PIDs are holding
 * VRAM and which of them Forge itself spawned.
 *
 * `collectSystemReport()` returns a typed struct; rendering lives in
 * `formatSystemReport.ts`. Three consumers need the same data at three widths
 * (sidebar `/system`, Telegram `/system`, and the `get_system_status` tool), so
 * collection and presentation are deliberately separate.
 */

import * as os from 'os';
import {
  describeProbeFailure,
  probeGpus,
  probeWindows,
  MIN_VRAM_BYTES,
  type AdapterSample,
  type DriveInfo,
  type GpuInfo,
  type WindowsProbe,
} from './systemProbes';

export type { DriveInfo, GpuInfo } from './systemProbes';
export { MIN_VRAM_BYTES } from './systemProbes';

/** One llama-server this window spawned. Ollama models and runtimes borrowed
 *  from another Forge window are excluded: their processes are not ours. */
export interface BackendProcess {
  model: string;
  pid: number;
}

export interface VramProcess {
  pid: number;
  /** null when the process exited between the counter read and the CIM query. */
  name: string | null;
  bytes: number;
  /** nvidia-smi GPU index, when the adapter LUID could be reconciled. */
  gpuIndex: number | null;
  /** Model name when this PID is a llama-server Forge started. */
  forgeModel: string | null;
}

export interface SystemReport {
  collectedAt: number;
  gpus: GpuInfo[];
  /** One line explaining why `gpus` is empty. Never both this and GPUs. */
  gpuError: string | null;
  vramProcesses: VramProcess[];
  vramProcessError: string | null;
  ram: { totalBytes: number; freeBytes: number };
  drives: DriveInfo[];
  minVramBytes: number;
}

export interface SystemReportDeps {
  /** Supplied by the backend pool; omitted by callers that have no pool. */
  backendProcesses?: () => readonly BackendProcess[];
  gpuProbe?: (signal?: AbortSignal) => Promise<GpuInfo[]>;
  windowsProbe?: (signal?: AbortSignal) => Promise<WindowsProbe>;
  memory?: () => { totalBytes: number; freeBytes: number };
}

/** Assign at least this much slack before calling an adapter/GPU pair a match:
 *  the two numbers are sampled milliseconds apart from different subsystems. */
const LUID_MATCH_FLOOR_MB = 384;
const LUID_MATCH_FRACTION = 0.25;

/**
 * Map each adapter LUID to an nvidia-smi GPU index by reconciling totals.
 *
 * The counter instance name carries a LUID, not an index, and nothing cheap
 * translates between them. But `\GPU Adapter Memory(luid_…)\Dedicated Usage`
 * and nvidia-smi's `memory.used` are measuring the same bytes, so the pairing
 * falls out of matching them — no new data source, no registry walk.
 *
 * Greedy on the closest pair first, and every assignment must clear the
 * tolerance: two idle GPUs both reading ~0 MB are genuinely ambiguous, and an
 * unattributed process is honest where a guessed card is not.
 */
export function mapLuidsToGpus(
  adapters: readonly AdapterSample[],
  gpus: readonly GpuInfo[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const adapter of adapters) {
    if (!adapter.luid) continue;
    // One LUID reports several `phys_N` instances; the card's usage is the sum.
    totals.set(adapter.luid, (totals.get(adapter.luid) ?? 0) + adapter.bytes);
  }

  const candidates: { luid: string; index: number; diffMb: number; toleranceMb: number }[] = [];
  for (const [luid, bytes] of totals) {
    for (const gpu of gpus) {
      if (gpu.memoryUsedMb === null) continue;
      const usedMb = bytes / (1024 * 1024);
      candidates.push({
        luid,
        index: gpu.index,
        diffMb: Math.abs(usedMb - gpu.memoryUsedMb),
        toleranceMb: Math.max(LUID_MATCH_FLOOR_MB, gpu.memoryUsedMb * LUID_MATCH_FRACTION),
      });
    }
  }
  candidates.sort((a, b) => a.diffMb - b.diffMb);

  const byLuid = new Map<string, number>();
  const takenGpus = new Set<number>();
  for (const candidate of candidates) {
    if (byLuid.has(candidate.luid) || takenGpus.has(candidate.index)) continue;
    if (candidate.diffMb > candidate.toleranceMb) continue;
    byLuid.set(candidate.luid, candidate.index);
    takenGpus.add(candidate.index);
  }
  return byLuid;
}

/** Join the counter samples to process names, Forge's own backends, and a card. */
export function buildVramProcesses(
  probe: WindowsProbe,
  gpus: readonly GpuInfo[],
  backends: readonly BackendProcess[],
): VramProcess[] {
  const luidToGpu = mapLuidsToGpus(probe.adapters, gpus);
  const forgePids = new Map(backends.map((entry) => [entry.pid, entry.model]));
  return probe.vram
    .map((sample) => ({
      pid: sample.pid,
      name: probe.processNames.get(sample.pid) ?? null,
      bytes: sample.bytes,
      gpuIndex: luidToGpu.get(sample.luid) ?? null,
      forgeModel: forgePids.get(sample.pid) ?? null,
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

function readMemory(): { totalBytes: number; freeBytes: number } {
  return { totalBytes: os.totalmem(), freeBytes: os.freemem() };
}

/**
 * Runs both probes in parallel under the caller's signal. A probe that fails
 * puts its reason in the report and leaves the other sections intact — the
 * whole point of separate error fields is that a missing nvidia-smi must not
 * cost the user their RAM and drive numbers.
 */
export async function collectSystemReport(
  deps: SystemReportDeps = {},
  signal?: AbortSignal,
): Promise<SystemReport> {
  const gpuProbe = deps.gpuProbe ?? probeGpus;
  const windowsProbe = deps.windowsProbe ?? probeWindows;
  const [gpuResult, windowsResult] = await Promise.allSettled([
    gpuProbe(signal),
    windowsProbe(signal),
  ]);

  const gpus = gpuResult.status === 'fulfilled' ? gpuResult.value : [];
  const gpuError = gpuResult.status === 'rejected' ? describeProbeFailure(gpuResult.reason) : null;

  const backends = deps.backendProcesses?.() ?? [];
  const probe = windowsResult.status === 'fulfilled' ? windowsResult.value : null;
  const vramProcessError =
    windowsResult.status === 'rejected'
      ? describeProbeFailure(windowsResult.reason)
      : (probe?.counterError ?? null);

  return {
    collectedAt: Date.now(),
    gpus,
    gpuError,
    vramProcesses: probe ? buildVramProcesses(probe, gpus, backends) : [],
    vramProcessError,
    ram: (deps.memory ?? readMemory)(),
    drives: probe?.drives ?? [],
    minVramBytes: MIN_VRAM_BYTES,
  };
}
