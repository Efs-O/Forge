import type { CheckpointSession } from '../checkpoint/CheckpointStack';
import type { ToolDispatch } from '../sidebar/ToolDispatch';

export type WorkerAccess = 'read' | 'write';

export interface WorkerSpec {
  id: string;
  model: string;
  task: string;
  access: WorkerAccess;
  context_files?: string[];
  allowed_paths?: string[];
  max_output_tokens?: number;
}

export interface WorkerRunRequest {
  workers: WorkerSpec[];
  review_task?: string;
}

export type WorkerStatus =
  | 'completed'
  | 'completed_no_changes'
  | 'declined'
  | 'cancelled'
  | 'timed_out'
  | 'failed_startup'
  | 'failed_model'
  | 'failed_tool'
  | 'failed_loop'
  | 'exhausted_steps'
  | 'exhausted_tokens';

export interface WorkerResult {
  id: string;
  model: string;
  status: WorkerStatus;
  summary: string;
  changedPaths: string[];
  error?: string;
  bestEffort?: boolean;
}

export interface WorkerRunResult {
  runId: string;
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
  executionMode: 'parallel' | 'serial' | 'best-effort';
  workers: WorkerResult[];
}

export interface WorkerActivity {
  runId: string;
  stage: 'run-started' | 'worker-started' | 'worker-finished';
  workerId?: string;
  model?: string;
  status?: WorkerStatus;
  executionMode?: WorkerRunResult['executionMode'];
  elapsedMs: number;
  changedPaths?: string[];
}

export interface WorkerRunContext {
  checkpoint: CheckpointSession;
  conversationId: string;
  abortSignal: AbortSignal;
  toolDispatch: ToolDispatch;
  coordinatorModel?: string;
}
