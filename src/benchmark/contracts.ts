export const BENCHMARK_ARMS = ['qwen-minimal', 'qwen-forge', 'claude-code', 'codex'] as const;
export type BenchmarkArm = (typeof BENCHMARK_ARMS)[number];

export interface BenchmarkTask {
  instance_id: string;
  dataset: string;
  split: string;
  /** Dataset revision accepted by the Hugging Face datasets-server API. */
  revision: string;
  timeout_minutes: number;
  /** Optional llama-server model id. Otherwise --model or the sole served model is used. */
  model?: string;
}

export interface BenchmarkRunResult {
  arm: BenchmarkArm;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'TIMEOUT';
  started_at: string;
  completed_at: string;
  workspace: string;
  runtime_file?: string;
  patch_file?: string;
  evaluator_file?: string;
  usage_file?: string;
  runtime_ms?: number;
  evaluator?: {
    resolved: boolean;
    exit_code: number | null;
  };
  error?: string;
}
