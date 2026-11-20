/**
 * The cloud half of getting a turn to its endpoint (openrouter, openai): resolve
 * the token and call the API directly, with no local backend to wait for.
 *
 * Split out of `ProviderTurn.ts`, which keeps the local path and the shared
 * unwind (`finishTurn`) the two halves settle through; cloud and local differ
 * only at the front.
 */

import { resolveCloudRequestTarget } from '../llm/CloudRequestResolver';
import { getLogger } from '../util/logger';
import { describeError } from '../util/describeError';
import { abortedTurnOutcome, type ForgeTurnOutcome } from './turnOutcome';
import { finishTurn, type ProviderTurnContext, type ProviderTurnRequest } from './ProviderTurn';
import {
  acquireExternalHold,
  isExternalCapacityRefusal,
  retryResumeAcquire,
  resumeWaitMessages,
  withSuspendedQuestionWait,
} from './providerQuestionWait';

const log = getLogger();

/** Cloud providers (openrouter, openai): no local backend — resolve the token and
 *  call the API directly. */
export async function runCloudProviderTurn(
  ctx: ProviderTurnContext,
  { conv, model, text, attachments, promptOptions, activeFile, ctrl, postC }: ProviderTurnRequest,
): Promise<ForgeTurnOutcome> {
  const convId = conv.id;
  let externalHold: { release(): void } | undefined;
  let apiKey: string;
  let baseUrl: string;
  try {
    externalHold = await acquireExternalHold(ctx.pool, model.name, convId, conv.title, ctrl.signal);
    ({ baseUrl, apiKey } = await resolveCloudRequestTarget(model, ctx.secrets, ctrl.signal));
    if (ctrl.signal.aborted) throw new Error('Cloud model startup cancelled.');
    log.info(`[AgentLoop] ${model.provider} token resolved for model=${model.name}`);
  } catch (err) {
    externalHold?.release();
    const msg = (err as Error).message;
    if (ctrl.signal.aborted) {
      postC({ type: 'done', finishReason: 'cancelled' });
      ctx.lifecycle.settle(convId);
      return abortedTurnOutcome(ctx.lifecycle.terminationKind(convId));
    }
    log.error(`[AgentLoop] ${model.provider} setup failed: ${msg}`);
    postC({ type: 'error', message: msg });
    // Setup can refuse a model switch while another chat holds the GPUs.
    // No prompt was committed yet; preserve it just as local startup does.
    if (!promptOptions?.internal && !promptOptions?.origin && !promptOptions?.sender)
      postC({ type: 'setInput', text });
    ctx.lifecycle.settle(convId);
    return { kind: 'failed', error: msg, finalText: '' };
  }
  ctx.commitUserPrompt(conv, text, attachments, promptOptions);
  promptOptions?.onStarted?.();
  ctx.events.onBackendReady?.(model.name);
  postC({ type: 'ready' });
  const checkpoint = ctx.checkpoints.beginTurn(`turn-${Date.now()}`, convId);
  ctx.lifecycle.markStreaming(convId);
  ctx.events.onGenerationStarted?.(model.name, convId);
  let finalText = '';
  let outcome: ForgeTurnOutcome | undefined;
  try {
    const result = await ctx.runModelTurn(
      async () => baseUrl,
      conv,
      model,
      activeFile,
      ctrl,
      postC,
      apiKey,
      checkpoint,
      async <T>(wait: () => Promise<T>): Promise<T> =>
        withSuspendedQuestionWait(
          ctx.lifecycle,
          convId,
          ctrl.signal,
          wait,
          async () => {
            externalHold?.release();
            externalHold = undefined;
          },
          async () => {
            const messages = resumeWaitMessages(convId, model.name, postC);
            externalHold = await retryResumeAcquire(
              ctrl.signal,
              async () => {
                let nextHold: { release(): void } | undefined;
                try {
                  nextHold = await acquireExternalHold(
                    ctx.pool,
                    model.name,
                    convId,
                    conv.title,
                    ctrl.signal,
                  );
                  const target = await resolveCloudRequestTarget(model, ctx.secrets, ctrl.signal);
                  if (ctrl.signal.aborted) throw new Error('Cloud model reacquisition cancelled.');
                  baseUrl = target.baseUrl;
                  apiKey = target.apiKey;
                  return nextHold;
                } catch (error) {
                  nextHold?.release();
                  throw error;
                }
              },
              isExternalCapacityRefusal,
              messages.waiting,
              messages.ready,
              (hold) => hold?.release(),
            );
            if (ctrl.signal.aborted) {
              externalHold?.release();
              externalHold = undefined;
              throw new Error('Cloud model reacquisition cancelled.');
            }
            ctx.events.onBackendReady?.(model.name);
          },
        ),
      () => apiKey,
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
    if (ctrl.signal.aborted) {
      postC({ type: 'done', finishReason: 'cancelled' });
    } else {
      // describeError, not `.message`: undici reports a refused connection, a
      // reset socket and a headers timeout all as "fetch failed" and keeps the
      // reason in `cause`. This is the line that produced the bare "fetch
      // failed" a remote user saw on 2026-09-09, with nothing left to diagnose.
      const rawMessage = describeError(err);
      const message =
        model.unload_path && isManagedServerInterruption(rawMessage)
          ? `the model server stopped or was unloaded during this turn (a crash, or another window loading a different model). ${rawMessage}`
          : rawMessage;
      log.error(`[AgentLoop] ${model.provider} agent loop error: ${message}`);
      postC({ type: 'error', message });
      outcome = { kind: 'failed', error: message, finalText: '' };
    }
  } finally {
    try {
      // The turn's own error path threw before deciding, which is a failure.
      finishTurn(ctx, conv, model, checkpoint, postC, false, finalText, outcome?.kind ?? 'failed');
    } finally {
      externalHold?.release();
    }
  }
  if (!outcome) throw new Error('Turn ended before an outcome was recorded.');
  return outcome;
}

function isManagedServerInterruption(message: string): boolean {
  return /I\/O operation on closed file|ECONNRESET|socket hang up|fetch failed|connection reset|stream.*closed/i.test(
    message,
  );
}
