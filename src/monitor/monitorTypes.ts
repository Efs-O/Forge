import type { GpuInfo } from '../system/systemProbes';

/** The GPU rows a reading carries beside the engine's own numbers. */
export type GpuProbeResult = { gpus: GpuInfo[]; error?: string };

export interface SlotStats {
  active: number;
  total: number;
  slots: Array<{ used: number | null; size: number | null }>;
}
export interface UpsStats {
  values: Record<string, string>;
  error?: string;
}
/** CPU package sensors from LibreHardwareMonitor's local web server. */
export interface CpuStats {
  tempC: number | null;
  powerW: number | null;
  error?: string;
}
/**
 * One Monitor reading, in the shape Strata's `GET /metrics` answers: the page is
 * Strata's, so the host sends Strata's document. With a Strata engine the host passes
 * the server's JSON through whole; for a llama.cpp engine `llamaMetricsShape.ts`
 * builds the same keys from what Forge can read. A key with no source stays absent —
 * the page hides the card rather than showing a made-up zero.
 */
export interface MetricsDocument {
  engine?: Record<string, unknown>;
  live?: Record<string, unknown>;
  requests?: unknown[];
  requests_kept?: number;
  conversation_cache?: Record<string, unknown> | null;
  totals?: Record<string, unknown>;
  monitor_totals?: Record<string, unknown>;
  monitor_totals_reset?: boolean;
  hardware?: Record<string, unknown>;
  hardware_static?: Record<string, unknown>;
  history?: Record<string, unknown>;
  time?: number;
  forge?: Record<string, unknown>;
  ups?: Record<string, unknown> | null;
  /** Set instead of metrics when there is nothing to show, so the page can say why. */
  error?: string;
  /** Set on the reading that follows a Clear whose reset the engine refused, so the page
   *  can say the totals did not reset instead of swallowing the failure. */
  clear_error?: string;
  [key: string]: unknown;
}
export type MonitorPanelToHost = { type: 'ready' } | { type: 'monitorClear' };
export type MonitorHostToPanel = { type: 'monitorMetrics'; metrics: MetricsDocument };

export function noStatsReaderMessage(model: string): string {
  return `No stats reader set for "${model}": add stats: llama or stats: strata to its engine in ~/.forge/policy.yaml.`;
}
