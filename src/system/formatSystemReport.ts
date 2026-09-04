/**
 * Rendering for `SystemReport`. Kept apart from collection because the same
 * struct is shown at three widths — the sidebar's monospace notice block,
 * Telegram's narrower one, and the `get_system_status` tool result.
 */

import type { SystemReport, VramProcess } from './SystemReport';
import { escapeTelegramHtml } from '../remote/telegramHtml';

export interface FormatOptions {
  /** Telegram and tool results: drop column padding that a phone would wrap. */
  compact?: boolean;
  /** Sidebar: label fields on separate lines instead of requiring a wide table. */
  sidebar?: boolean;
  /** Telegram HTML: emphasize Forge's registered backend/model without trusting its name as markup. */
  telegramHtml?: boolean;
}

const GIB = 1024 * 1024 * 1024;

function gib(bytes: number): number {
  return bytes / GIB;
}

/** Marketing prefixes cost a third of the line and identify nothing. */
function shortGpuName(name: string): string {
  return name.replace(/^NVIDIA\s+(GeForce\s+)?/u, '').trim() || name;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function formatGpuLine(gpu: SystemReport['gpus'][number], compact: boolean): string {
  const memory =
    gpu.memoryUsedMb === null || gpu.memoryTotalMb === null
      ? 'memory n/a'
      : `${(gpu.memoryUsedMb / 1024).toFixed(1)} / ${(gpu.memoryTotalMb / 1024).toFixed(1)} GB`;
  const util = gpu.utilizationPercent === null ? 'n/a' : `${gpu.utilizationPercent}%`;
  const temp = gpu.temperatureC === null ? 'n/a' : `${gpu.temperatureC}°C`;
  const name = shortGpuName(gpu.name);
  if (compact) return `GPU ${gpu.index}  ${name}  ${memory}  ${util}  ${temp}`;
  return (
    `GPU ${gpu.index}  ${pad(name, 16)}${padStart(memory, 16)}` +
    `${padStart(util, 6)}${padStart(temp, 7)}`
  );
}

function formatProcessLine(process: VramProcess, last: boolean, compact: boolean): string {
  const tag = process.forgeModel ? `  (Forge backend: ${process.forgeModel})` : '';
  const name = process.name ?? '(exited)';
  const size = `${gib(process.bytes).toFixed(2)} GB`;
  const branch = compact ? '  ' : `  ${last ? '└' : '├'} `;
  if (compact) return `${branch}${process.pid}  ${name}  ${size}${tag}`;
  return `${branch}${padStart(String(process.pid), 6)}  ${pad(name, 22)}${padStart(size, 9)}${tag}`;
}

function formatDriveLine(drive: SystemReport['drives'][number], compact: boolean): string {
  const free = `${gib(drive.freeBytes).toFixed(0)} GB free`;
  const total = `${gib(drive.totalBytes).toFixed(0)} GB`;
  if (compact) return `${drive.drive}  ${free} / ${total}`;
  return `${pad(drive.drive, 7)}${pad(free, 16)}of ${total}`;
}

function gpuSection(report: SystemReport, compact: boolean): string[] {
  const lines: string[] = [];
  if (report.gpuError) {
    lines.push(`GPUs   unavailable — ${report.gpuError}`);
  }
  const attributed = new Set<number>();
  for (const gpu of report.gpus) {
    lines.push(formatGpuLine(gpu, compact));
    const owned = report.vramProcesses.filter((entry) => entry.gpuIndex === gpu.index);
    owned.forEach((entry, position) => {
      attributed.add(entry.pid);
      lines.push(formatProcessLine(entry, position === owned.length - 1, compact));
    });
  }
  const unattributed = report.vramProcesses.filter((entry) => !attributed.has(entry.pid));
  if (unattributed.length > 0) {
    // Named rather than silently folded into a card: the LUID reconciliation
    // declines to guess when two adapters report near-identical totals, and a
    // process shown under the wrong GPU is worse than one shown under none.
    lines.push(report.gpus.length > 0 ? 'VRAM (card not resolved)' : 'VRAM by process');
    unattributed.forEach((entry, position) => {
      lines.push(formatProcessLine(entry, position === unattributed.length - 1, compact));
    });
  }
  if (report.vramProcessError) {
    lines.push(`Per-process VRAM unavailable — ${report.vramProcessError}`);
  } else if (report.vramProcesses.length === 0 && !report.gpuError) {
    lines.push(
      `No process is holding more than ${(report.minVramBytes / GIB).toFixed(2)} GB of VRAM.`,
    );
  }
  return lines;
}

/**
 * A sidebar is normally narrower than the report's desktop table. Keep the
 * hierarchy, but put each card's metrics on their own labelled line so no
 * horizontal scrolling is needed to read a GPU or its owner.
 */
function sidebarGpuSection(report: SystemReport): string[] {
  const lines: string[] = [];
  if (report.gpuError) lines.push(`GPUs   unavailable — ${report.gpuError}`);

  const attributed = new Set<number>();
  for (const gpu of report.gpus) {
    const memory =
      gpu.memoryUsedMb === null || gpu.memoryTotalMb === null
        ? 'memory n/a'
        : `${(gpu.memoryUsedMb / 1024).toFixed(1)} / ${(gpu.memoryTotalMb / 1024).toFixed(1)} GB`;
    const util = gpu.utilizationPercent === null ? 'n/a' : `${gpu.utilizationPercent}%`;
    const temp = gpu.temperatureC === null ? 'n/a' : `${gpu.temperatureC}°C`;
    lines.push(`GPU ${gpu.index}  ${shortGpuName(gpu.name)}`);
    lines.push(`  VRAM ${memory} · ${util} · ${temp}`);

    const owned = report.vramProcesses.filter((entry) => entry.gpuIndex === gpu.index);
    owned.forEach((entry, position) => {
      attributed.add(entry.pid);
      const branch = position === owned.length - 1 ? '└' : '├';
      const name = entry.name ?? '(exited)';
      lines.push(`  ${branch} ${entry.pid}  ${name} · ${gib(entry.bytes).toFixed(2)} GB`);
      if (entry.forgeModel) lines.push(`      Forge backend: ${entry.forgeModel}`);
    });
  }

  const unattributed = report.vramProcesses.filter((entry) => !attributed.has(entry.pid));
  if (unattributed.length > 0) {
    lines.push(report.gpus.length > 0 ? 'VRAM (card not resolved)' : 'VRAM by process');
    unattributed.forEach((entry, position) => {
      const branch = position === unattributed.length - 1 ? '└' : '├';
      const name = entry.name ?? '(exited)';
      lines.push(`  ${branch} ${entry.pid}  ${name} · ${gib(entry.bytes).toFixed(2)} GB`);
      if (entry.forgeModel) lines.push(`      Forge backend: ${entry.forgeModel}`);
    });
  }
  if (report.vramProcessError) {
    lines.push(`Per-process VRAM unavailable — ${report.vramProcessError}`);
  } else if (report.vramProcesses.length === 0 && !report.gpuError) {
    lines.push(
      `No process is holding more than ${(report.minVramBytes / GIB).toFixed(2)} GB of VRAM.`,
    );
  }
  return lines;
}

function formatSidebarSystemReport(report: SystemReport): string {
  const lines = sidebarGpuSection(report);
  const usedRam = report.ram.totalBytes - report.ram.freeBytes;
  lines.push('');
  lines.push(`RAM  ${gib(usedRam).toFixed(1)} / ${gib(report.ram.totalBytes).toFixed(1)} GB used`);
  for (const drive of report.drives) {
    lines.push(
      `${drive.drive}  ${gib(drive.freeBytes).toFixed(0)} GB free / ${gib(drive.totalBytes).toFixed(0)} GB`,
    );
  }
  return lines.join('\n');
}

export function formatSystemReport(report: SystemReport, options: FormatOptions = {}): string {
  if (options.sidebar) return formatSidebarSystemReport(report);
  const compact = options.compact === true;
  const lines = gpuSection(report, compact);

  const usedRam = report.ram.totalBytes - report.ram.freeBytes;
  lines.push('');
  lines.push(
    compact
      ? `RAM  ${gib(usedRam).toFixed(1)} / ${gib(report.ram.totalBytes).toFixed(1)} GB used`
      : `${pad('RAM', 7)}${gib(usedRam).toFixed(1)} / ${gib(report.ram.totalBytes).toFixed(1)} GB used`,
  );
  for (const drive of report.drives) lines.push(formatDriveLine(drive, compact));

  const text = lines.join('\n');
  return options.telegramHtml ? withTelegramForgeBackendEmphasis(text, report.vramProcesses) : text;
}

/** Escape the complete report, then re-insert only Forge-owned backend labels as Telegram HTML. */
function withTelegramForgeBackendEmphasis(text: string, processes: readonly VramProcess[]): string {
  const models = [
    ...new Set(processes.flatMap((process) => (process.forgeModel ? [process.forgeModel] : []))),
  ];
  const markers = models.map((model, index) => ({ model, marker: `@@FORGE_BACKEND_${index}@@` }));
  let marked = text;
  for (const { model, marker } of markers) {
    marked = marked.replaceAll(`Forge backend: ${model}`, marker);
  }
  let escaped = escapeTelegramHtml(marked);
  for (const { model, marker } of markers) {
    escaped = escaped.replaceAll(
      marker,
      `<b><u>◆ FORGE BACKEND: ${escapeTelegramHtml(model.toUpperCase())}</u></b>`,
    );
  }
  return escaped;
}
