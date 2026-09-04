/**
 * OS-facing probes for the machine report: `nvidia-smi` for per-GPU totals and
 * one fixed PowerShell script for everything Windows knows and NVML does not.
 *
 * Split from `SystemReport.ts` so the parsers can be unit-tested against
 * captured output without an extension host or a GPU.
 *
 * Why two sources: on this machine (WDDM, verified 2026-09-04)
 * `nvidia-smi --query-compute-apps` reports `[N/A]` for every process's memory
 * AND lists graphics clients such as explorer.exe, so it can answer neither
 * "how much" nor "which process". The WDDM performance counters — the same ones
 * Task Manager reads — answer both. nvidia-smi keeps the per-GPU totals, name,
 * utilisation and temperature, which the counters do not carry.
 */

import * as os from 'os';
import { z } from 'zod';
import { spawnAndWait, ExecCommandError, type SpawnResult } from '../util/processSpawn';

/** Processes under this are desktop noise. The probe that motivated the report
 *  separated one 14.70 GB consumer from a 0.25 GB floor, so the threshold has
 *  two orders of magnitude of room either side. */
export const MIN_VRAM_BYTES = 150 * 1024 * 1024;

/**
 * `Get-Counter` alone measured 1.6 s, the CIM process query 0.5–1 s, and
 * powershell.exe itself costs a cold start on top. The 4 s in the design note
 * predates those measurements being added together.
 */
export const PROBE_TIMEOUT_MS = 12_000;
const NVIDIA_SMI_TIMEOUT_MS = 6_000;

export interface GpuInfo {
  /** nvidia-smi ordering. NOT llama.cpp's CUDA ordering — never present this
   *  as the `-dev N` / CUDA_VISIBLE_DEVICES index (see `config/types.ts`). */
  index: number;
  name: string;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  utilizationPercent: number | null;
  temperatureC: number | null;
}

export interface VramSample {
  pid: number;
  /** Adapter LUID from the counter instance name; '' when it carried none. */
  luid: string;
  bytes: number;
}

export interface AdapterSample {
  luid: string;
  bytes: number;
}

export interface DriveInfo {
  drive: string;
  freeBytes: number;
  totalBytes: number;
}

export interface WindowsProbe {
  vram: VramSample[];
  adapters: AdapterSample[];
  processNames: Map<number, string>;
  drives: DriveInfo[];
  /** Set when the GPU counters themselves failed; the rest may still be good. */
  counterError: string | null;
}

// ── nvidia-smi ────────────────────────────────────────────────────────────────

const NVIDIA_SMI_QUERY = 'index,name,memory.used,memory.total,utilization.gpu,temperature.gpu';

function parseNumericField(raw: string): number | null {
  const value = Number(raw);
  // `[N/A]` and `[Not Supported]` are what a driver returns for a field it will
  // not expose; both must read as "unknown", never as 0.
  return raw.length > 0 && Number.isFinite(value) ? value : null;
}

/** Parse `--format=csv,noheader,nounits` rows. Tolerates the `[N/A]` cells the
 *  driver emits per field, which is exactly what WDDM does here. */
export function parseNvidiaSmiCsv(stdout: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const index = parseNumericField(cells[0]);
    if (index === null) continue;
    gpus.push({
      index,
      name: cells[1],
      memoryUsedMb: parseNumericField(cells[2]),
      memoryTotalMb: parseNumericField(cells[3]),
      utilizationPercent: parseNumericField(cells[4]),
      temperatureC: parseNumericField(cells[5]),
    });
  }
  return gpus;
}

function nvidiaSmiFailure(result: SpawnResult): string {
  const detail = (result.stderr || result.stdout).trim().split(/\r?\n/u)[0] ?? '';
  return `nvidia-smi exited ${result.exitCode ?? 'null'}${detail ? `: ${detail}` : ''}`;
}

/**
 * Resolved from PATH only. A machine without an NVIDIA driver, or with
 * nvidia-smi somewhere unusual, gets the failure reported in the report — no
 * hardcoded `System32` rescue path, and no empty section pretending to be zero.
 */
export async function probeGpus(signal?: AbortSignal): Promise<GpuInfo[]> {
  const result = await spawnAndWait(
    'nvidia-smi',
    [`--query-gpu=${NVIDIA_SMI_QUERY}`, '--format=csv,noheader,nounits'],
    os.tmpdir(),
    NVIDIA_SMI_TIMEOUT_MS,
    {},
    signal,
  );
  if (result.exitCode !== 0) throw new Error(nvidiaSmiFailure(result));
  return parseNvidiaSmiCsv(result.stdout);
}

/** Turns a spawn failure into the one line the report shows for the section. */
export function describeProbeFailure(err: unknown): string {
  if (err instanceof ExecCommandError && err.kind === 'missing_executable') {
    return `${err.program} is not on PATH`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ── Windows performance counters + CIM ────────────────────────────────────────

/**
 * Source-controlled and fixed, exactly like `safePowerShellTool`'s script: no
 * value from a model or a user is ever spliced into it. The one input is a
 * numeric byte threshold, and it travels as an environment variable.
 *
 * `Get-Counter` paths are localised by Windows, so on a non-English install the
 * counter lookup throws. That message is carried out in `gpuError` rather than
 * swallowed — an empty process list would otherwise read as "nothing is using
 * the GPU", which is the opposite of the truth.
 */
const SYSTEM_PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$min = [double] $env:FORGE_SYSTEM_MIN_VRAM_BYTES',
  '$gpuProcesses = @()',
  '$gpuAdapters = @()',
  "$gpuError = ''",
  'try {',
  "  $paths = @('\\GPU Process Memory(*)\\Dedicated Usage', '\\GPU Adapter Memory(*)\\Dedicated Usage')",
  '  foreach ($sample in (Get-Counter -Counter $paths).CounterSamples) {',
  '    $bytes = [double] $sample.CookedValue',
  '    $instance = [string] $sample.InstanceName',
  "    $luid = ''",
  "    if ($instance -match 'luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)') { $luid = $Matches[1] }",
  "    if ($sample.Path -like '*gpu process memory*') {",
  "      if ($bytes -ge $min -and $instance -match '^pid_(\\d+)_') {",
  '        $gpuProcesses += [pscustomobject]@{ pid = [int] $Matches[1]; luid = $luid; bytes = $bytes }',
  '      }',
  '    } else {',
  '      $gpuAdapters += [pscustomobject]@{ luid = $luid; bytes = $bytes }',
  '    }',
  '  }',
  '} catch { $gpuError = $_.Exception.Message }',
  '$wanted = @($gpuProcesses | ForEach-Object { $_.pid } | Sort-Object -Unique)',
  '$processes = @()',
  'if ($wanted.Count -gt 0) {',
  // `-contains` against the collected ids compares VALUES; a WQL -Filter would
  // have meant building query source out of them. Same rule as query_powershell.
  '  $processes = @(Get-CimInstance Win32_Process |',
  '    Where-Object { $wanted -contains [int] $_.ProcessId } |',
  '    ForEach-Object { [pscustomobject]@{ pid = [int] $_.ProcessId; name = [string] $_.Name } })',
  '}',
  "$drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' |",
  '  ForEach-Object { [pscustomobject]@{ drive = [string] $_.DeviceID; free = [double] $_.FreeSpace; size = [double] $_.Size } })',
  '[pscustomobject]@{',
  '  gpuProcesses = $gpuProcesses',
  '  gpuAdapters = $gpuAdapters',
  '  processes = $processes',
  '  drives = $drives',
  '  gpuError = $gpuError',
  '} | ConvertTo-Json -Depth 4 -Compress',
].join('\n');

/** Windows PowerShell 5.1 has no `ConvertTo-Json -AsArray`, so a one-element
 *  collection serialises as a bare object. Every list is normalised here. */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

const probeSchema = z.object({
  gpuProcesses: z.preprocess(
    toArray,
    z.array(z.object({ pid: z.number().int(), luid: z.string(), bytes: z.number() })),
  ),
  gpuAdapters: z.preprocess(toArray, z.array(z.object({ luid: z.string(), bytes: z.number() }))),
  processes: z.preprocess(toArray, z.array(z.object({ pid: z.number().int(), name: z.string() }))),
  drives: z.preprocess(
    toArray,
    z.array(z.object({ drive: z.string(), free: z.number(), size: z.number() })),
  ),
  gpuError: z.string(),
});

export function parseWindowsProbe(stdout: string): WindowsProbe {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('the PowerShell probe returned no output');
  const parsed = probeSchema.parse(JSON.parse(trimmed));
  return {
    vram: parsed.gpuProcesses,
    adapters: parsed.gpuAdapters,
    processNames: new Map(parsed.processes.map((entry) => [entry.pid, entry.name])),
    drives: parsed.drives.map((entry) => ({
      drive: entry.drive,
      freeBytes: entry.free,
      totalBytes: entry.size,
    })),
    counterError: parsed.gpuError.trim() || null,
  };
}

export async function probeWindows(signal?: AbortSignal): Promise<WindowsProbe> {
  const result = await spawnAndWait(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SYSTEM_PROBE_SCRIPT],
    os.tmpdir(),
    PROBE_TIMEOUT_MS,
    { FORGE_SYSTEM_MIN_VRAM_BYTES: String(MIN_VRAM_BYTES) },
    signal,
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/u)[0] ?? '';
    throw new Error(
      `powershell.exe exited ${result.exitCode ?? 'null'}${detail ? `: ${detail}` : ''}`,
    );
  }
  return parseWindowsProbe(result.stdout);
}
