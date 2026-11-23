import type { ControlStats } from '../backend/controlStats';
import type { GpuInfo } from '../system/systemProbes';

export interface SlotStats {
  active: number;
  total: number;
  slots: Array<{ used: number | null; size: number | null }>;
}
export interface LlamaStats {
  slots?: SlotStats;
  promptTokensPerSecond?: number;
  predictedTokensPerSecond?: number;
  requestsProcessing?: number;
  requestsDeferred?: number;
  error?: string;
}
export interface StrataStats {
  state?: string;
  decodeTokS?: number;
  decodeTokSMean?: number;
  prefillTokSMean?: number;
  promptRead?: number;
  promptTotal?: number;
  running?: number;
  waiting?: number;
  slots?: number;
  contextUsed?: number;
  contextSize?: number;
  error?: string;
}
export interface EngineMonitor {
  name: string;
  provider: string;
  engine?: LlamaStats | StrataStats | { error: string };
}
export interface UpsStats {
  values: Record<string, string>;
  error?: string;
}
export type GpuProbeResult = { gpus: GpuInfo[]; error?: string };
export interface MonitorSnapshot {
  gpus: GpuProbeResult;
  engines: EngineMonitor[];
  forge: ControlStats;
  ups?: UpsStats;
}
export type MonitorPanelToHost = { type: 'ready' };
export type MonitorHostToPanel = { type: 'monitorSnapshot'; snapshot: MonitorSnapshot };

export function noStatsReaderMessage(model: string): string {
  return `No stats reader set for "${model}": add stats: llama or stats: strata to its engine in ~/.forge/policy.yaml.`;
}
