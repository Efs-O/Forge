import * as path from 'path';
import type { CheckpointSession } from '../checkpoint/CheckpointStack';
import { capResultText } from '../tools/resultCap';
import { MAX_WORKER_FINAL_CHARS } from '../workers/limits';
import type { WorkerResult, WorkerSpec } from '../workers/types';
import { CliAgentDriver } from './CliAgentDriver';
import { resolveCliExecutable } from './resolveCliExecutable';
import type { CliAgentName, CliAgentRunStatus } from './types';

export interface RunCliWorkerOptions {
  spec: WorkerSpec;
  cliName: CliAgentName;
  /** Raw `cli` config field (bare name or absolute path) — resolved here. */
  cliExecutable: string;
  workspaceRoot: string;
  /** Resolved, workspace-contained absolute paths from WorkerAccessPolicy —
   *  the same validated set the normal write tools are confined to. */
  writablePaths: readonly string[];
  checkpoint: CheckpointSession;
  abortSignal: AbortSignal;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
  /** Test-only injection point. */
  driver?: CliAgentDriver;
}

const STATUS_MAP: Record<CliAgentRunStatus, WorkerResult['status']> = {
  completed: 'completed',
  cancelled: 'cancelled',
  timed_out: 'timed_out',
  failed: 'failed_model',
};

function buildTaskPrompt(
  spec: WorkerSpec,
  workspaceRoot: string,
  writablePaths: readonly string[],
): string {
  const scope =
    spec.access === 'write'
      ? `You may modify ONLY these paths (workspace root: ${workspaceRoot}):\n${writablePaths
          .map((target) => `- ${path.relative(workspaceRoot, target) || target}`)
          .join(
            '\n',
          )}\nDo not modify any other file. Use your own tools; Forge is not supplying any.`
      : 'This is a read-only analysis task. Do not modify any files.';
  const context = spec.context_files?.length
    ? `Suggested starting files:\n${spec.context_files.map((file) => `- ${file}`).join('\n')}`
    : '';
  return [`Task:\n${spec.task}`, scope, context].filter(Boolean).join('\n\n');
}

/**
 * Runs one `provider: cli` worker: resolves the executable, snapshots a
 * checkpoint over its writable scope BEFORE spawning (so Keep/Undo covers
 * edits the CLI makes with its own tools — Forge never sees the individual
 * writes to snapshot lazily like the normal write tools do), then streams
 * the external agent run to completion.
 */
export async function runCliWorker(options: RunCliWorkerOptions): Promise<WorkerResult> {
  const { spec } = options;
  const base = { id: spec.id, model: spec.model, changedPaths: [] as string[] };

  let executable: string;
  try {
    executable = await resolveCliExecutable(options.cliExecutable, options.cliName);
  } catch (err) {
    return {
      ...base,
      status: 'failed_startup',
      summary: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (spec.access === 'write') {
    for (const target of options.writablePaths) options.checkpoint.snapshotBefore(target);
  }

  const driver = options.driver ?? new CliAgentDriver();
  const task = buildTaskPrompt(spec, options.workspaceRoot, options.writablePaths);
  const result = await driver.run({
    cliName: options.cliName,
    executable,
    task,
    access: spec.access,
    cwd: options.workspaceRoot,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    signal: options.abortSignal,
    onEvent: (event) => {
      if (event.kind === 'status') options.onProgress?.(event.text);
    },
  });

  const summary = capResultText(result.finalText, MAX_WORKER_FINAL_CHARS);
  return {
    ...base,
    status: STATUS_MAP[result.status],
    summary,
    // changedPaths stays empty: the CLI edits with its own tools, so Forge
    // has no verified per-file record the way WorkerAccessPolicy tracks for
    // native-tool workers — only the writable scope was declared, not what
    // it actually touched.
    ...(result.error ? { error: result.error } : {}),
  };
}
