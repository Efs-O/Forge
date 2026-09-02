export const BENCHMARK_ARMS = ['qwen-minimal', 'qwen-forge', 'claude-code', 'codex'] as const;
export type BenchmarkArm = (typeof BENCHMARK_ARMS)[number];

export interface BenchmarkTask {
  instance_id: string;
  dataset: string;
  split: string;
  timeout_minutes: number;
}

export interface BenchmarkRunResult {
  arm: BenchmarkArm;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'TIMEOUT';
  started_at: string;
  completed_at: string;
  workspace: string;
  error?: string;
}
