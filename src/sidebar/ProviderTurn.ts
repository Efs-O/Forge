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
import type { BackendTurnLease } from '../backend/poolTypes';
import type { CheckpointStack, CheckpointSession } from '../checkpoint/CheckpointStack';
import type { IBackendPool } from '../backend/BackendPool';
import type { TurnLifecycle } from './TurnLifecycle';
import type { SidebarProviderEvents } from './AgentLoop';
import { getLogger } from '../util/logger';
import type * as vscode from 'vscode';
import type { UserPromptOptions } from './transcriptMutations';
import type { ToolCallingLoopResult } from '../agent/ToolCallingLoop';
import type { QuestionWaitRunner } from '../tools/toolContract';
import { abortedTurnOutcome, type ForgeTurnOutcome } from './turnOutcome';
import type { AgentProgressEvent } from './AgentProgress';
import { describeError } from '../util/describeError';
import { checkpointReadyMessage } from './checkpointStats';
import {
  isLocalCapacityRefusal,
  retryResumeAcquire,
  resumeWaitMessages,
  withSuspendedQuestionWait,
} from './providerQuestionWait';

const log = getLogger();

export interface ProviderTurnContext {
  pool: IBackendPool;
  lifecycle: TurnLifecycle;
  checkpoints: CheckpointStack;
  events: SidebarProviderEvents;
  secrets?: vscode.SecretStorage;
  /** Mirrors visible progress to remote surfaces (Telegram, WhatsApp). */
  emitAgentProgress: (event: AgentProgressEvent) => void;
  commitUserPrompt: (
    conv: ConversationRuntime,
    text: string,
    attachments?: AttachmentData[],
    options?: UserPromptOptions,
  ) => void;
  runModelTurn: (
    resolveBaseUrl: () => Promise<string>,
    conv: ConversationRuntime,
    model: ModelConfig,
    activeFile: string | undefined,
    ctrl: AbortController,
    postC: (msg: HostToWebview) => void,
    apiKey: string | undefined,
    checkpoint: CheckpointSession,
    withQuestionWait?: QuestionWaitRunner,
    getApiKey?: () => string | undefined,
  ) => Promise<ToolCallingLoopResult>;
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

/**
 * Shared unwind: commit the checkpoint, release the turn, tell the status bar.
 *
 * `settle` belongs in a `finally`, not last (BL-024). It is the only thing that
 * resolves the promise `TurnLifecycle.stopStreaming` awaits, and the checkpoint
 * commit re-reads every file the turn touched — `CheckpointSession.commit` →
 * `fingerprintMemoryState`, which rethrows every read error except ENOENT — so
 * a file an editor, watcher or antivirus is holding throws here. Left
 * unsettled, the next Stop, tab close or `waitForCancelledTurns` waits on a
 * promise whose resolver the next `register` has already replaced, and the chat
 * cannot send again for the life of the window. The reply is worth more than
 * the checkpoint, so a failed commit is reported as its own warning row — the
 * raw errno text names the file — and the turn still completes. It is a notice
 * with `severity: 'warning'`, not an error row: the webview maps `error` to
 * ERROR and that reads as a failed turn when the reply arrived fine, and
 * `warning` is what reaches a remote chat as its own message.
 */
export function finishTurn(
  ctx: ProviderTurnContext,
  conv: ConversationRuntime,
  model: ModelConfig,
  checkpoint: CheckpointSession,
  postC: (msg: HostToWebview) => void,
  releaseBackend: boolean,
  finalText: string,
  outcome: ForgeTurnOutcome['kind'],
): void {
  const convId = conv.id;
  ctx.lifecycle.clearStreaming(convId);
  if (releaseBackend) ctx.lifecycle.clearBackend(convId);
  conv.updatedAt = Date.now();
  try {
    const depthBefore = ctx.checkpoints.depth(convId);
    ctx.checkpoints.commitTurn(checkpoint);
    if (ctx.checkpoints.depth(convId) > depthBefore)
      postC(checkpointReadyMessage(ctx.checkpoints, convId));
  } catch (err) {
    // What the user actually lost: `commit()` is what fires `onCommit`, so this
    // turn's file changes get no Keep/Undo entry at all.
    const message =
      `Forge: the reply finished, but it could not record this turn's file ` +
      `changes for Undo: ${describeError(err)}. Undo will not cover this turn; ` +
      'check the files with git diff.';
    log.error(
      `[AgentLoop] checkpoint commit failed model=${model.name} conv=${convId}: ${message}`,
    );
    // A webview post must not be what leaves the conversation unsettled.
    try {
      postC({ type: 'notice', severity: 'warning', message });
    } catch {
      /* the reply and the settlement matter more than this row */
    }
  }
  try {
    ctx.events.onGenerationFinished?.(model.name, convId, finalText, outcome);
  } catch (err) {
    // The status-bar hook is also what clears `activeTurnModels`, so it runs
    // even after a failed commit; a throw here must not skip settle either.
    log.warn(`[AgentLoop] generation-finished hook failed model=${model.name}: ${String(err)}`);
  } finally {
    ctx.lifecycle.settle(convId);
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

/**
 * Headline for the remote progress message while the local backend is still
 * coming up. A remote reader cannot see the sidebar's `backendStarting` row, so
 * without this the message reads "Forge: working…" through a cold
 * `llama-server` spawn plus a multi-second model load — which looks like a
 * stalled turn rather than a startup.
 */
const BACKEND_START_PHASE = 'Forge: starting the local backend and loading the model…';

/** Local providers: acquire (and if necessary start) the backend first. */
export async function runLocalProviderTurn(
  ctx: ProviderTurnContext,
  { conv, model, text, attachments, promptOptions, activeFile, ctrl, postC }: ProviderTurnRequest,
): Promise<ForgeTurnOutcome> {
  const convId = conv.id;
  let backend: BackendController;
  let turnLease: BackendTurnLease | undefined;
  let announcedStart = false;
  const notice = setTimeout(() => {
    announcedStart = true;
    postC({ type: 'backendStarting', message: 'Starting backend, please wait…' });
    ctx.emitAgentProgress({ conversationId: convId, kind: 'phase', text: BACKEND_START_PHASE });
  }, BACKEND_START_NOTICE_MS);
  try {
    try {
      try {
        if (typeof ctx.pool.acquireForTurn === 'function') {
          turnLease = await ctx.pool.acquireForTurn(model.name, { signal: ctrl.signal });
        } else {
          const legacyBackend = await ctx.pool.acquire(model.name);
          turnLease = { backend: legacyBackend, release: async () => undefined };
        }
        backend = turnLease.backend;
      } finally {
        // Cleared on the failure path too: a spawn that fails inside the window
        // reports its own error, and the notice would arrive after it.
        clearTimeout(notice);
        // Restore the default headline whichever way the wait ended, so the
        // startup phase never outlives the startup.
        if (announcedStart) {
          ctx.emitAgentProgress({ conversationId: convId, kind: 'phase', text: undefined });
        }
      }
      ctx.lifecycle.setBackend(convId, backend);
      ctx.events.onBackendReady?.(model.name);
      if (ctrl.signal.aborted) {
        // Release BEFORE settling. This path throws nothing, so the `catch`
        // above never runs for it, and it sits outside the second `try` — the
        // outer `finally` is a net, not the release point, because `settle`
        // already told the window the turn is over while `turnPins[key]` was
        // still held. Pressing Stop during a cold load used to leave that pin
        // at 1 for the life of the window: the slot stopped being an eviction
        // candidate and `prepareExternal` reported "a turn is running on it"
        // with no turn running.
        await turnLease?.release();
        postC({ type: 'done', finishReason: 'cancelled' });
        ctx.lifecycle.settle(convId);
        return abortedTurnOutcome(ctx.lifecycle.terminationKind(convId));
      }
      ctx.commitUserPrompt(conv, text, attachments, promptOptions);
      promptOptions?.onStarted?.();
      postC({ type: 'ready' });
    } catch (err) {
      await turnLease?.release();
      const msg = ctrl.signal.aborted
        ? 'Backend start cancelled.'
        : `Backend failed to start: ${describeError(err)}`;
      ctx.events.onBackendError?.(msg);
      ctx.events.onTurnFailed?.(convId, msg);
      postC({ type: 'backendDown', message: msg });
      // The prompt never reached conv.messages, so the next sync drops its
      // optimistic row; hand it back, as an admission refusal does (U20-01).
      if (
        !ctrl.signal.aborted &&
        !promptOptions?.internal &&
        !promptOptions?.origin &&
        !promptOptions?.sender
      )
        postC({ type: 'setInput', text });
      if (ctrl.signal.aborted) postC({ type: 'done', finishReason: 'cancelled' });
      ctx.lifecycle.settle(convId);
      return ctrl.signal.aborted
        ? abortedTurnOutcome(ctx.lifecycle.terminationKind(convId))
        : { kind: 'failed', error: msg, finalText: '' };
    }

    const checkpoint = ctx.checkpoints.beginTurn(`turn-${Date.now()}`, convId);
    ctx.lifecycle.markStreaming(convId);
    ctx.events.onGenerationStarted?.(model.name, convId);
    let finalText = '';
    let outcome: ForgeTurnOutcome | undefined;
    try {
      const result = await ctx.runModelTurn(
        // The POOL, not `backend`. A model unloaded mid-turn comes back through
        // `startSlot`, which builds a new controller on a newly claimed port —
        // the one we hold is then orphaned and its baseUrl() is stale forever.
        // Re-acquiring is a cheap map lookup while the slot is live, and blocks
        // for the reload when it is not.
        async () => (await ctx.pool.acquire(model.name)).baseUrl(),
        conv,
        model,
        activeFile,
        ctrl,
        postC,
        undefined,
        checkpoint,
        async <T>(wait: () => Promise<T>): Promise<T> =>
          withSuspendedQuestionWait(
            ctx.lifecycle,
            convId,
            ctrl.signal,
            wait,
            async () => {
              await turnLease?.release();
              turnLease = undefined;
            },
            async () => {
              const messages = resumeWaitMessages(convId, model.name, postC);
              if (!ctx.pool.acquireForTurn) {
                throw new Error('Backend pool cannot safely reacquire the turn model.');
              }
              turnLease = await retryResumeAcquire(
                ctrl.signal,
                async () => {
                  const lease = await ctx.pool.acquireForTurn!(model.name, { signal: ctrl.signal });
                  if (ctrl.signal.aborted) {
                    await lease.release();
                    throw new Error('Model reacquisition cancelled.');
                  }
                  return lease;
                },
                isLocalCapacityRefusal,
                messages.waiting,
                messages.ready,
                (lease) => lease.release(),
              );
              if (ctrl.signal.aborted) {
                await turnLease.release();
                turnLease = undefined;
                throw new Error('Model reacquisition cancelled.');
              }
              backend = turnLease.backend;
              ctx.lifecycle.setBackend(convId, backend);
              ctx.events.onBackendReady?.(model.name);
            },
          ),
      );
      const incompleteReason = ctx.lifecycle.incompleteReason(convId);
      outcome = ctrl.signal.aborted
        ? abortedTurnOutcome(ctx.lifecycle.terminationKind(convId))
        : {
            kind: 'completed',
            finalText: result.finalText,
            finishReason: result.finishReason,
            ...(incompleteReason ? { incompleteReason } : {}),
          };
      finalText = result.finalText;
    } catch (err) {
      outcome = ctrl.signal.aborted
        ? abortedTurnOutcome(ctx.lifecycle.terminationKind(convId))
        : {
            kind: 'failed',
            error: err instanceof Error ? err.message : String(err),
            finalText: '',
          };
      const message = err instanceof Error ? err.message : String(err);
      if (ctrl.signal.aborted) {
        postC({ type: 'done', finishReason: 'cancelled' });
      } else {
        // `provider` is optional and unset for local llama entries, which is how
        // this line read "[AgentLoop] undefined chat failed" in the 09-05 logs.
        log.error(
          `[AgentLoop] ${model.provider ?? 'local'} chat failed model=${model.name}: ${message}`,
        );
        ctx.events.onBackendError?.(message);
        ctx.events.onTurnFailed?.(convId, message);
        postC({ type: 'error', message });
        outcome = { kind: 'failed', error: message, finalText: '' };
      }
    } finally {
      try {
        // The turn's own error path threw before deciding, which is a failure.
        finishTurn(ctx, conv, model, checkpoint, postC, true, finalText, outcome?.kind ?? 'failed');
      } finally {
        await turnLease?.release();
      }
    }
    if (!outcome) throw new Error('Turn ended before an outcome was recorded.');
    return outcome;
  } finally {
    // Idempotent net for later exits; the explicit releases above free the slot before settle.
    await turnLease?.release();
  }
}
