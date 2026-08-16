/**
 * A turn that delegates to workers and then reviews their output.
 *
 * Split out of `AgentLoop`. Structurally it is two turns in one: the worker run
 * itself, then a coordinator review that goes through the ordinary model turn
 * against the same checkpoint.
 */

import * as vscode from 'vscode';
import type { ModelConfig } from '../config/types';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { CheckpointStack, CheckpointSession } from '../checkpoint/CheckpointStack';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolDispatch } from './ToolDispatch';
import type { ToolApprovalService } from './ToolApprovalService';
import type { WorkerOrchestrationService } from '../workers/WorkerOrchestrationService';
import type { WorkerRunRequest, WorkerRunResult } from '../workers/types';
import type { ForgeConfig } from '../config/types';
import type { IBackendPool } from '../backend/BackendPool';
import type { TurnLifecycle } from './TurnLifecycle';
import { buildWorkerReviewPrompt } from '../workers/WorkerPrompts';
import { resolveToolPermissions } from '../tools/PermissionResolver';
import { isCloudProvider } from '../llm/CloudProviders';
import { resolveCloudRequestTarget } from '../llm/CloudRequestResolver';

export interface WorkerTurnContext {
  getConfig: () => ForgeConfig;
  pool: IBackendPool;
  toolRegistry: ToolRegistry;
  toolDispatch: ToolDispatch;
  approvals: ToolApprovalService;
  workerService: WorkerOrchestrationService;
  checkpoints: CheckpointStack;
  lifecycle: TurnLifecycle;
  secrets?: vscode.SecretStorage;
  post: (msg: HostToWebview) => void;
  waitForCancelledTurns: () => Promise<void>;
  commitUserPrompt: (conv: ConversationRuntime, text: string) => void;
  /** The ordinary model turn, used here for the coordinator's review. */
  runModelTurn: (
    baseUrl: string,
    conv: ConversationRuntime,
    model: ModelConfig,
    activeFile: string | undefined,
    ctrl: AbortController,
    postC: (msg: HostToWebview) => void,
    apiKey: string | undefined,
    checkpoint: CheckpointSession,
  ) => Promise<void>;
}

export async function runWorkerTurn(
  ctx: WorkerTurnContext,
  conv: ConversationRuntime,
  model: ModelConfig,
  request: WorkerRunRequest,
): Promise<WorkerRunResult> {
  await ctx.waitForCancelledTurns();
  const convId = conv.id;
  const ctrl = new AbortController();
  ctx.lifecycle.register(convId, ctrl);
  ctx.lifecycle.markStreaming(convId);
  const checkpoint = ctx.checkpoints.beginTurn(`workers-${Date.now()}`, convId);
  const postC = (message: HostToWebview): void =>
    ctx.post({ ...message, conversationId: convId } as HostToWebview);
  postC({ type: 'generationStarted' });
  try {
    const dispatchTool = ctx.toolRegistry.get('dispatch_workers');
    if (!dispatchTool) throw new Error('Forge: dispatch_workers is unavailable.');
    ctx.toolRegistry.assertAllowed(
      dispatchTool,
      resolveToolPermissions(ctx.getConfig()),
      request as unknown as Record<string, unknown>,
    );
    if (ctx.workerService.hasCloudTargets(request)) {
      const approved = await ctx.approvals.request(
        'dispatch_workers',
        'Cloud workers may send their tasks and workspace file contents to configured providers.',
        true,
        convId,
        ctrl.signal,
      );
      if (!approved) throw new Error('Cloud worker launch declined.');
    }
    postC({ type: 'toolActivity', toolName: 'dispatch_workers', detail: 'starting workers' });
    const result = await ctx.workerService.run(request, {
      checkpoint,
      conversationId: convId,
      abortSignal: ctrl.signal,
      toolDispatch: ctx.toolDispatch,
      coordinatorModel: model.name,
    });
    ctx.commitUserPrompt(conv, buildWorkerReviewPrompt(result, request.review_task));
    postC({
      type: 'workerStatus',
      runId: result.runId,
      stage: 'review-started',
      elapsedMs: 0,
    });
    await runCoordinatorReview(ctx, conv, model, ctrl, checkpoint, postC);
    return result;
  } catch (err) {
    postC({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    const depthBefore = ctx.checkpoints.depth(convId);
    ctx.checkpoints.commitTurn(checkpoint);
    if (ctx.checkpoints.depth(convId) > depthBefore) postC({ type: 'checkpointReady' });
    ctx.lifecycle.clearBackend(convId);
    ctx.lifecycle.clearStreaming(convId);
    ctx.lifecycle.settle(convId);
  }
}

async function runCoordinatorReview(
  ctx: WorkerTurnContext,
  conv: ConversationRuntime,
  model: ModelConfig,
  ctrl: AbortController,
  checkpoint: CheckpointSession,
  postC: (msg: HostToWebview) => void,
): Promise<void> {
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (isCloudProvider(model.provider)) {
    const target = await resolveCloudRequestTarget(model, ctx.secrets);
    await ctx.runModelTurn(
      target.baseUrl,
      conv,
      model,
      activeFile,
      ctrl,
      postC,
      target.apiKey,
      checkpoint,
    );
    return;
  }
  const backend = await ctx.pool.acquire(model.name);
  ctx.lifecycle.setBackend(conv.id, backend);
  await ctx.runModelTurn(
    backend.baseUrl(),
    conv,
    model,
    activeFile,
    ctrl,
    postC,
    undefined,
    checkpoint,
  );
}
