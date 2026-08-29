/**
 * Getting a turn to a model endpoint: resolving a cloud target or starting a
 * local backend, then running the turn against the right base URL.
 *
 * Split out of `AgentLoop`, which keeps the routing decision. The two paths
 * differ only at the front — a cloud provider resolves a token, a local one
 * waits for `llama-server` — and share the checkpoint/lifecycle unwind.
 */

import type { ModelConfig } from '../config/types';
import type { AttachmentData, HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { BackendController } from '../backend/BackendController';
import type { CheckpointStack, CheckpointSession } from '../checkpoint/CheckpointStack';
import type { IBackendPool } from '../backend/BackendPool';
import type { TurnLifecycle } from './TurnLifecycle';
import type { SidebarProviderEvents } from './AgentLoop';
import { resolveCloudRequestTarget } from '../llm/CloudRequestResolver';
import { getLogger } from '../util/logger';
import type * as vscode from 'vscode';
import type { UserPromptOptions } from './transcriptMutations';

const log = getLogger();

export interface ProviderTurnContext {
  pool: IBackendPool;
  lifecycle: TurnLifecycle;
  checkpoints: CheckpointStack;
  events: SidebarProviderEvents;
  secrets?: vscode.SecretStorage;
  commitUserPrompt: (
    conv: ConversationRuntime,
    text: string,
    attachments?: AttachmentData[],
    options?: UserPromptOptions,
  ) => void;
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

export interface ProviderTurnRequest {
  conv: ConversationRuntime;
  model: ModelConfig;
  text: string;
  attachments: AttachmentData[] | undefined;
  promptOptions?: UserPromptOptions;
  activeFile: string | undefined;
  ctrl: AbortController;
  postC: (msg: HostToWebview) => void;
}

/** Shared unwind: commit the checkpoint, release the turn, tell the status bar. */
function finishTurn(
  ctx: ProviderTurnContext,
  conv: ConversationRuntime,
  model: ModelConfig,
  checkpoint: CheckpointSession,
  postC: (msg: HostToWebview) => void,
  releaseBackend: boolean,
): void {
  const convId = conv.id;
  ctx.lifecycle.clearStreaming(convId);
  if (releaseBackend) ctx.lifecycle.clearBackend(convId);
  conv.updatedAt = Date.now();
  const depthBefore = ctx.checkpoints.depth(convId);
  ctx.checkpoints.commitTurn(checkpoint);
  if (ctx.checkpoints.depth(convId) > depthBefore) postC({ type: 'checkpointReady' });
  ctx.events.onGenerationFinished?.(model.name, convId);
  ctx.lifecycle.settle(convId);
}

/** Cloud providers (xai, openrouter): no local backend — resolve the token and
 *  call the API directly. */
export async function runCloudProviderTurn(
  ctx: ProviderTurnContext,
  { conv, model, text, attachments, promptOptions, activeFile, ctrl, postC }: ProviderTurnRequest,
): Promise<void> {
  const convId = conv.id;
  let apiKey: string;
  let baseUrl: string;
  try {
    ({ baseUrl, apiKey } = await resolveCloudRequestTarget(model, ctx.secrets));
    log.info(`[AgentLoop] ${model.provider} token resolved for model=${model.name}`);
  } catch (err) {
    const msg = (err as Error).message;
    log.error(`[AgentLoop] ${model.provider} setup failed: ${msg}`);
    postC({ type: 'error', message: msg });
    ctx.lifecycle.settle(convId);
    return;
  }
  ctx.commitUserPrompt(conv, text, attachments, promptOptions);
  ctx.events.onBackendReady?.(model.name);
  postC({ type: 'ready' });
  const checkpoint = ctx.checkpoints.beginTurn(`turn-${Date.now()}`, convId);
  ctx.lifecycle.markStreaming(convId);
  ctx.events.onGenerationStarted?.(model.name, convId);
  try {
    await ctx.runModelTurn(baseUrl, conv, model, activeFile, ctrl, postC, apiKey, checkpoint);
  } catch (err) {
    if (ctrl.signal.aborted) {
      postC({ type: 'done', finishReason: 'cancelled' });
    } else {
      log.error(`[AgentLoop] ${model.provider} agent loop error: ${(err as Error).message}`);
      postC({ type: 'error', message: (err as Error).message });
    }
  } finally {
    finishTurn(ctx, conv, model, checkpoint, postC, false);
  }
}

/**
 * How long `pool.acquire` may run before the turn admits it is waiting on the
 * backend.
 *
 * The announcement used to be unconditional, which put "Starting backend…" and
 * "Backend ready." in the transcript on every single prompt — a warm pool
 * returns in single-digit milliseconds, so both rows described nothing. A cold
 * `llama-server` spawn takes seconds, so the message still lands long before
 * the wait becomes uncomfortable. `CliTurn` gates the same pair on the first
 * prompt of a session; this is the local-backend equivalent.
 */
const BACKEND_START_NOTICE_MS = 500;

/** Local providers: acquire (and if necessary start) the backend first. */
export async function runLocalProviderTurn(
  ctx: ProviderTurnContext,
  { conv, model, text, attachments, promptOptions, activeFile, ctrl, postC }: ProviderTurnRequest,
): Promise<void> {
  const convId = conv.id;
  let backend: BackendController;
  const notice = setTimeout(
    () => postC({ type: 'backendStarting', message: 'Starting backend, please wait…' }),
    BACKEND_START_NOTICE_MS,
  );
  try {
    try {
      backend = await ctx.pool.acquire(model.name);
    } finally {
      // Cleared on the failure path too: a spawn that fails inside the window
      // reports its own error, and the notice would arrive after it.
      clearTimeout(notice);
    }
    ctx.lifecycle.setBackend(convId, backend);
    ctx.events.onBackendReady?.(model.name);
    if (ctrl.signal.aborted) {
      postC({ type: 'done', finishReason: 'cancelled' });
      ctx.lifecycle.settle(convId);
      return;
    }
    ctx.commitUserPrompt(conv, text, attachments, promptOptions);
    postC({ type: 'ready' });
  } catch (err) {
    const msg = ctrl.signal.aborted
      ? 'Backend start cancelled.'
      : `Backend failed to start: ${(err as Error).message}`;
    ctx.events.onBackendError?.(msg);
    postC({ type: 'backendDown', message: msg });
    ctx.lifecycle.settle(convId);
    return;
  }

  const checkpoint = ctx.checkpoints.beginTurn(`turn-${Date.now()}`, convId);
  ctx.lifecycle.markStreaming(convId);
  ctx.events.onGenerationStarted?.(model.name, convId);
  try {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (ctrl.signal.aborted) {
      postC({ type: 'done', finishReason: 'cancelled' });
    } else {
      log.error(`[AgentLoop] ${model.provider} chat failed model=${model.name}: ${message}`);
      ctx.events.onBackendError?.(message);
      postC({ type: 'error', message });
    }
  } finally {
    finishTurn(ctx, conv, model, checkpoint, postC, true);
  }
}
