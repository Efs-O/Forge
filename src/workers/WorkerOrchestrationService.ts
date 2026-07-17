import type * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { resolveRequestModel } from '../config/ConfigResolver';
import { resolveCloudRequestTarget } from '../llm/CloudRequestResolver';
import {
  classifyModelRoute,
  isCloudModelRoute,
  type ModelRoute,
} from '../llm/ModelRouteClassifier';
import { resolveToolPermissions } from '../tools/PermissionResolver';
import type { ToolRegistry } from '../tools/ToolRegistry';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import {
  WORKER_RUN_TIMEOUT_MS,
  MAX_WORKERS,
  MAX_CONTEXT_HINTS,
  MAX_WRITABLE_PATHS,
  MAX_WORKER_OUTPUT_TOKENS,
  MAX_WORKER_TASK_CHARS,
  MAX_REVIEW_TASK_CHARS,
} from './limits';
import type {
  WorkerResult,
  WorkerRunContext,
  WorkerRunRequest,
  WorkerRunResult,
  WorkerSpec,
  WorkerActivity,
} from './types';
import { WorkerAccessPolicy } from './WorkerAccessPolicy';
import { WorkerLoop, type WorkerExecutionTarget } from './WorkerLoop';

interface ResolvedWorker {
  spec: WorkerSpec;
  model: ModelConfig;
  route: ModelRoute;
  policy: WorkerAccessPolicy;
}

export interface WorkerOrchestrationDeps {
  getConfig: () => ForgeConfig;
  pool: IBackendPool;
  registry: ToolRegistry;
  workspaceRoot: string;
  secrets?: vscode.SecretStorage;
  onActivity?: (activity: WorkerActivity, conversationId: string) => void;
}

export class WorkerOrchestrationService {
  private readonly loop: WorkerLoop;

  constructor(private readonly deps: WorkerOrchestrationDeps) {
    this.loop = new WorkerLoop(deps.getConfig, deps.registry, deps.workspaceRoot);
  }

  hasCloudTargets(request: WorkerRunRequest): boolean {
    const config = this.deps.getConfig();
    return request.workers.some((worker) => {
      try {
        return isCloudModelRoute(classifyModelRoute(resolveRequestModel(config, worker.model)));
      } catch {
        return false;
      }
    });
  }

  async run(request: WorkerRunRequest, context: WorkerRunContext): Promise<WorkerRunResult> {
    const startedAt = Date.now();
    const runId = `workers-${startedAt}-${Math.random().toString(36).slice(2)}`;
    this.validateRequest(request);
    const allowed = resolveToolPermissions(this.deps.getConfig());
    for (const permission of ['read', 'delegate'] as const) {
      if (!allowed.has(permission)) throw new Error(`Worker orchestration requires ${permission}.`);
    }
    if (request.workers.some((worker) => worker.access === 'write') && !allowed.has('write')) {
      throw new Error('Worker orchestration requires write for write-access workers.');
    }
    const resolved = this.resolveWorkers(request.workers);
    if (
      resolved.some((worker) => isCloudModelRoute(worker.route)) &&
      !allowed.has('cloud-worker')
    ) {
      throw new Error('Cloud workers require permissions.agents.cloud_workers: true.');
    }
    this.rejectWriteConflicts(resolved);

    const timeout = AbortSignal.timeout(WORKER_RUN_TIMEOUT_MS);
    const signal = AbortSignal.any([context.abortSignal, timeout]);
    const runContext = { ...context, abortSignal: signal };
    const local = resolved.filter((worker) => worker.route !== 'direct-cloud');
    const primary = context.coordinatorModel ?? this.deps.getConfig().active_model ?? '';
    const group =
      local.length > 0
        ? await this.deps.pool.acquireGroupForDelegation(
            primary,
            local.map((worker) => worker.spec.model),
          )
        : undefined;
    try {
      const targets = await this.buildTargets(resolved, local, group?.backends ?? []);
      const serial = this.requiresSerial(resolved);
      const executionMode: WorkerRunResult['executionMode'] = serial
        ? 'serial'
        : resolved.some((worker) => worker.route.includes('ollama'))
          ? 'best-effort'
          : 'parallel';
      this.emit(context, {
        runId,
        stage: 'run-started',
        executionMode,
        elapsedMs: 0,
      });
      const results: WorkerResult[] = [];
      if (serial) {
        for (let index = 0; index < resolved.length; index++) {
          const worker = resolved[index];
          const target = targets[index];
          if (worker && target) {
            results.push(
              await this.runWorker(worker, target, runContext, runId, startedAt, context),
            );
          }
        }
      } else {
        const settled = await Promise.allSettled(
          resolved.map((worker, index) => {
            const target = targets[index];
            if (!target) throw new Error(`Missing execution target for ${worker.spec.id}`);
            return this.runWorker(worker, target, runContext, runId, startedAt, context);
          }),
        );
        settled.forEach((entry, index) => {
          if (entry.status === 'fulfilled') results.push(entry.value);
          else {
            const worker = resolved[index];
            if (worker) {
              results.push({
                id: worker.spec.id,
                model: worker.spec.model,
                status: signal.aborted ? 'cancelled' : 'failed_model',
                summary: '',
                changedPaths: worker.policy.changedPaths(),
                error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
              });
            }
          }
        });
      }
      if (timeout.aborted && !context.abortSignal.aborted) {
        for (const result of results) {
          if (result.status === 'cancelled') result.status = 'timed_out';
        }
      }
      return {
        runId,
        status: this.aggregate(results, context.abortSignal.aborted),
        executionMode,
        workers: results,
      };
    } finally {
      group?.release();
    }
  }

  private async runWorker(
    worker: ResolvedWorker,
    target: WorkerExecutionTarget,
    runContext: WorkerRunContext,
    runId: string,
    startedAt: number,
    originalContext: WorkerRunContext,
  ): Promise<WorkerResult> {
    this.emit(originalContext, {
      runId,
      stage: 'worker-started',
      workerId: worker.spec.id,
      model: worker.spec.model,
      elapsedMs: Date.now() - startedAt,
    });
    const result = await this.loop.run(worker.spec, target, worker.policy, runContext);
    this.emit(originalContext, {
      runId,
      stage: 'worker-finished',
      workerId: worker.spec.id,
      model: worker.spec.model,
      status: result.status,
      elapsedMs: Date.now() - startedAt,
      changedPaths: result.changedPaths,
    });
    return result;
  }

  private emit(context: WorkerRunContext, activity: WorkerActivity): void {
    this.deps.onActivity?.(activity, context.conversationId);
  }

  private resolveWorkers(specs: WorkerSpec[]): ResolvedWorker[] {
    const config = this.deps.getConfig();
    return specs.map((spec) => {
      const model = resolveRequestModel(config, spec.model);
      return {
        spec,
        model,
        route: classifyModelRoute(model),
        policy: new WorkerAccessPolicy(
          this.deps.workspaceRoot,
          spec.access,
          spec.allowed_paths ?? [],
        ),
      };
    });
  }

  private async buildTargets(
    workers: ResolvedWorker[],
    local: ResolvedWorker[],
    localBackends: readonly import('../backend/BackendController').BackendController[],
  ): Promise<WorkerExecutionTarget[]> {
    const localIndex = new Map(local.map((worker, index) => [worker.spec.id, index]));
    return Promise.all(
      workers.map(async (worker) => {
        if (worker.route === 'direct-cloud') {
          const cloud = await resolveCloudRequestTarget(worker.model, this.deps.secrets);
          return { model: worker.model, ...cloud, bestEffort: false };
        }
        const index = localIndex.get(worker.spec.id);
        const backend = index === undefined ? undefined : localBackends[index];
        if (!backend) throw new Error(`Missing local backend for worker ${worker.spec.id}`);
        return {
          model: worker.model,
          baseUrl: backend.baseUrl(),
          bestEffort: worker.route.includes('ollama'),
        };
      }),
    );
  }

  private requiresSerial(workers: ResolvedWorker[]): boolean {
    if (workers.length < 2) return false;
    const direct = workers.filter((worker) => worker.route === 'local-llama');
    if (direct.length !== workers.length) return false;
    const baseNames = new Set(direct.map((worker) => worker.model.name));
    return (
      baseNames.size === 1 &&
      this.deps.pool.parallelCapacity(direct[0]?.spec.model ?? '') < direct.length
    );
  }

  private rejectWriteConflicts(workers: ResolvedWorker[]): void {
    const owners = new Map<string, string>();
    for (const worker of workers) {
      for (const target of worker.policy.writablePaths()) {
        const key = process.platform === 'win32' ? target.toLowerCase() : target;
        const previous = owners.get(key);
        if (previous)
          throw new Error(
            `Worker write conflict: ${previous} and ${worker.spec.id} both own ${target}`,
          );
        owners.set(key, worker.spec.id);
      }
    }
  }

  private validateRequest(request: WorkerRunRequest): void {
    if (request.workers.length < 1 || request.workers.length > MAX_WORKERS) {
      throw new Error(`Worker run requires 1-${MAX_WORKERS} workers.`);
    }
    const ids = new Set<string>();
    for (const worker of request.workers) {
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(worker.id) || ids.has(worker.id)) {
        throw new Error(`Invalid or duplicate worker id: ${worker.id}`);
      }
      ids.add(worker.id);
      if (!worker.task || worker.task.length > MAX_WORKER_TASK_CHARS)
        throw new Error(`Invalid task for ${worker.id}`);
      if (!worker.model) throw new Error(`Worker ${worker.id} needs a model.`);
      if (worker.access !== 'read' && worker.access !== 'write') {
        throw new Error(`Worker ${worker.id} needs explicit read or write access.`);
      }
      if (worker.access === 'read' && worker.allowed_paths !== undefined) {
        throw new Error(`Read-only worker ${worker.id} must not include allowed_paths.`);
      }
      if (
        worker.access === 'write' &&
        (worker.allowed_paths === undefined ||
          worker.allowed_paths.length < 1 ||
          worker.allowed_paths.length > MAX_WRITABLE_PATHS ||
          new Set(worker.allowed_paths).size !== worker.allowed_paths.length)
      ) {
        throw new Error(`Write worker ${worker.id} needs a valid allowed path.`);
      }
      if (
        (worker.context_files?.length ?? 0) > MAX_CONTEXT_HINTS ||
        new Set(worker.context_files ?? []).size !== (worker.context_files?.length ?? 0)
      ) {
        throw new Error(`Worker ${worker.id} has invalid context files.`);
      }
      for (const contextFile of worker.context_files ?? []) {
        if (typeof contextFile !== 'string' || contextFile.trim().length === 0) {
          throw new Error(`Worker ${worker.id} has invalid context files.`);
        }
        resolveWorkspacePath(contextFile, {
          workspaceRoot: this.deps.workspaceRoot,
          allowAbsolute: false,
          mustBeInsideWorkspace: true,
        });
      }
      if (
        worker.max_output_tokens !== undefined &&
        (!Number.isInteger(worker.max_output_tokens) ||
          worker.max_output_tokens < 1 ||
          worker.max_output_tokens > MAX_WORKER_OUTPUT_TOKENS)
      ) {
        throw new Error(`Worker ${worker.id} has invalid max_output_tokens.`);
      }
    }
    if ((request.review_task?.length ?? 0) > MAX_REVIEW_TASK_CHARS)
      throw new Error('Review task is too long.');
  }

  private aggregate(results: WorkerResult[], cancelled: boolean): WorkerRunResult['status'] {
    if (cancelled) return 'cancelled';
    const completed = results.filter((result) => result.status.startsWith('completed')).length;
    if (completed === results.length) return 'completed';
    if (completed > 0) return 'partial';
    return 'failed';
  }
}
