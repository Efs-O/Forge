/**
 * What happens to a request once its conversation chain is reserved: the turn
 * loop and its session-log rows, continuations, the fate of undelivered tells,
 * and the end-of-turn wake. `SendPipeline` owns admission — whether a send may
 * start at all; this module owns running it.
 *
 * Split out of `SendPipeline`. Every guard here exists because a second turn on
 * a conversation that is still streaming corrupts its transcript, and because a
 * tell the user typed during a turn must never be stranded in the inbox.
 */

import type { AttachmentData } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { ModelConfig } from '../config/types';
import type { UserPromptOptions } from './transcriptMutations';
import type { SendPipelineDeps, SendRequestMetadata } from './SendPipeline';
import type { ChatAttachmentRef } from '../llm/types';
import type { SessionLogCoordinator } from './SessionLogCoordinator';
import type { RequestChainContext } from './RequestChainLifecycle';
import type { AdmissionDecision } from './ContextBudgetPublisher';
import {
  toRequestOutcome,
  type ForgeRequestOutcome,
  type ForgeTurnEndKind,
  type ForgeTurnOutcome,
} from './turnOutcome';
import { isContextExhaustionReason } from '../agent/truncationRecovery';
import { backgroundExecutionManager } from '../tools/BackgroundExecutionManager';
import { notifyConversationSettled } from './workerChatWake';
import {
  groupTellBatches,
  heldTellsOf,
  inputTextOf,
  runsAfterStop,
  sendNowOrder,
  type TellBatch,
} from './undeliveredTells';
import { getLogger } from '../util/logger';

const log = getLogger();

function turnEndDetails(turn: ForgeTurnOutcome | ForgeRequestOutcome): {
  outcome: ForgeTurnEndKind;
  finishReason?: string | null;
} {
  switch (turn.kind) {
    case 'completed':
      return {
        outcome: 'completed',
        ...('finishReason' in turn ? { finishReason: turn.finishReason } : {}),
      };
    case 'failed':
      return { outcome: 'failed' };
    case 'cancelled':
      return { outcome: 'cancelled' };
    case 'interrupted':
      return { outcome: 'interrupted' };
    default: {
      const exhaustive: never = turn;
      return exhaustive;
    }
  }
}

/** Everything admission hands to execution: the reservation and the prompt. */
export interface SendChainRequest {
  deps: SendPipelineDeps;
  /** The pipeline's own coordinator, so both halves write one session log. */
  sessionLogs: SessionLogCoordinator;
  conv: ConversationRuntime;
  chain: RequestChainContext;
  selectedModel: ModelConfig;
  text: string;
  attachments: AttachmentData[] | undefined;
  promptOptions: UserPromptOptions | undefined;
  metadata: SendRequestMetadata | undefined;
  attachmentRefs: ChatAttachmentRef[];
  initialPromptOptions: UserPromptOptions;
  /** The pipeline's own `send`, bound: a tell that survives the release becomes
   *  a new addressed request, which re-enters admission. */
  send: (
    text: string,
    attachments: AttachmentData[] | undefined,
    conversationId: string,
    promptOptions: UserPromptOptions | undefined,
    metadata: SendRequestMetadata | undefined,
  ) => Promise<ForgeRequestOutcome>;
}

export async function runSendChain({
  deps,
  sessionLogs,
  conv,
  chain,
  selectedModel,
  text,
  attachments,
  promptOptions,
  metadata,
  attachmentRefs,
  initialPromptOptions,
  send,
}: SendChainRequest): Promise<ForgeRequestOutcome> {
  let outcome: ForgeRequestOutcome;
  const pendingTellBatches: TellBatch[] = [];
  // Set when "Send now" interrupted the turn: its batches run after release.
  let sendNowHeld = false;
  try {
    outcome = await deps.requestChains.run(chain, async () => {
      const stoppedBeforeTurn = (): ForgeRequestOutcome | undefined => {
        const kind = deps.requestChains.terminationKind(chain);
        if (!kind) return undefined;
        if (!promptOptions?.internal && !promptOptions?.origin && !promptOptions?.sender)
          deps.post({ type: 'setInput', text, conversationId: conv.id });
        deps.post({ type: 'done', finishReason: 'cancelled', conversationId: conv.id });
        return { kind };
      };
      const stopped = stoppedBeforeTurn();
      if (stopped) return stopped;
      let nextText = text;
      let nextAttachments = attachments;
      // Only the FIRST request of a chain carries the files the user sent; a
      // continuation re-sends neither the bytes nor their references.
      let nextOptions: UserPromptOptions | undefined = attachmentRefs.length
        ? { ...initialPromptOptions, attachmentRefs }
        : initialPromptOptions;
      if (!promptOptions?.internal && deps.evaluateAtAdmission) {
        let decision: AdmissionDecision = { kind: 'proceed' };
        try {
          decision = await deps.evaluateAtAdmission(conv);
        } catch (err) {
          // The threshold-aware path reports its own failures as `blocked`; a
          // throw here is a defect in the check, not evidence of an over-full window.
          log.warn(`[SendPipeline] admission check failed: ${(err as Error).message}`);
        }
        if (decision.kind === 'blocked') {
          // The prompt never reached conv.messages; hand it back so it is not lost.
          deps.post({ type: 'error', message: decision.reason, conversationId: conv.id });
          if (!promptOptions?.origin && !promptOptions?.sender)
            deps.post({ type: 'setInput', text, conversationId: conv.id });
          deps.post({ type: 'done', finishReason: 'stop', conversationId: conv.id });
          sessionLogs.logTurnEnd(conv.id, 'blocked', 0);
          return { kind: 'failed', error: decision.reason };
        }
        if (!deps.requestChains.isCurrent(chain)) return { kind: 'cancelled' };
        const stoppedAtAdmission = stoppedBeforeTurn();
        if (stoppedAtAdmission) return stoppedAtAdmission;
      }
      for (;;) {
        let turn: ForgeTurnOutcome;
        const requestCountBeforeTurn = conv.model_request_count ?? 0;
        try {
          turn = await deps.agentLoop.runTurn(
            conv,
            selectedModel,
            nextText,
            nextAttachments,
            nextOptions,
          );
        } finally {
          deps.persistSession();
          deps.postSessionSync();
          sessionLogs.flushSessionLog(conv.id);
        }
        // After the flush, so the error lands beneath the rows it followed. A
        // failed turn writes no messages of its own, so without this the file
        // ends on the last successful tool row and reads as a healthy turn.
        if (turn.kind === 'failed') sessionLogs.logTurnError(conv.id, turn.error);
        if (turn.kind === 'cancelled' || turn.kind === 'interrupted') {
          sessionLogs.logTurnStopped(conv.id, turn.kind, turn.stopReason);
        }
        const end = turnEndDetails(turn);
        const rounds = Math.max(
          0,
          (conv.model_request_count ?? requestCountBeforeTurn) - requestCountBeforeTurn,
        );
        sessionLogs.logTurnEnd(conv.id, end.outcome, rounds, end.finishReason);
        const undelivered = deps.midTurnInbox.takeUndelivered(conv.id);
        pendingTellBatches.push(...groupTellBatches(sendNowOrder(turn.kind, undelivered)));
        if (pendingTellBatches.length > 0) {
          if (turn.kind === 'cancelled' || turn.kind === 'interrupted') {
            sendNowHeld = runsAfterStop(turn.kind, undelivered);
            return toRequestOutcome(turn);
          }
          const nextBatch = pendingTellBatches.shift()!;
          const nextCreatedAt = nextBatch.createdAt ?? Date.now();
          if (!nextBatch.internal) {
            deps.post({
              type: 'userPrompt',
              text: nextBatch.text,
              createdAt: nextCreatedAt,
              conversationId: conv.id,
            });
          }
          deps.post({ type: 'generationStarted', conversationId: conv.id });
          nextText = nextBatch.text;
          nextAttachments = undefined;
          nextOptions = {
            ...(nextBatch.internal ? { internal: true } : {}),
            ...(nextBatch.origin ? { origin: nextBatch.origin } : {}),
            createdAt: nextCreatedAt,
          };
          continue;
        }
        // Context exhaustion is a failed provider turn, but it is also the one
        // failure auto-compaction can repair. Returning here used to bypass the
        // compaction policy entirely (most visible in background Telegram
        // conversations). Let that failure reach the addressed post-turn
        // policy; all other failures still retain their original outcome.
        const recoverableContextFailure =
          turn.kind === 'failed' && isContextExhaustionReason(turn.error);
        if (turn.kind !== 'completed' && !recoverableContextFailure) return toRequestOutcome(turn);
        if (deps.requestChains.isContinuationSuppressed(chain)) return toRequestOutcome(turn);
        deps.requestChains.setStage(chain, 'evaluating');
        const action = await deps.evaluateAfterTurn(conv, chain, turn);
        const terminationKind = deps.requestChains.terminationKind(chain);
        if (terminationKind) {
          const incompleteReason = turn.kind === 'completed' ? turn.incompleteReason : undefined;
          return {
            kind: terminationKind,
            ...(turn.finalText ? { finalText: turn.finalText } : {}),
            ...(incompleteReason ? { incompleteReason } : {}),
          };
        }
        if (!action) return toRequestOutcome(turn);

        deps.requestChains.setStage(chain, 'continuing');
        deps.post({ type: 'generationStarted', conversationId: conv.id });
        nextText = action.text;
        nextAttachments = undefined;
        nextOptions = action.options;
      }
    });
  } catch (error) {
    returnUndeliveredTells(deps, conv.id, pendingTellBatches);
    if (!metadata?.suppressWorkerWake) {
      await notifyFinalOutcome(conv.id, {
        kind: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
  // A cancelled chain (Stop, forge.sh stop, a remote Stop) keeps its jobs
  // running and visible to monitor_execution; only their wake is cleared. An
  // interrupted chain is not disarmed: its steering turn still wants the notice.
  if (outcome.kind === 'cancelled') backgroundExecutionManager.disarmNotify(conv.id);
  const undeliveredAfterRelease = deps.midTurnInbox.takeUndelivered(conv.id);
  const tellBatches = [
    ...(sendNowHeld || outcome.kind === 'cancelled' || outcome.kind === 'interrupted'
      ? pendingTellBatches
      : []),
    ...groupTellBatches(undeliveredAfterRelease),
  ];
  if (tellBatches.length === 0) {
    if (!metadata?.suppressWorkerWake) await notifyFinalOutcome(conv.id, outcome);
    return outcome;
  }
  const stopped = outcome.kind === 'cancelled' || outcome.kind === 'interrupted';
  if (stopped && !sendNowHeld && !runsAfterStop(outcome.kind, undeliveredAfterRelease)) {
    const userText = inputTextOf(tellBatches);
    if (userText) deps.post({ type: 'setInput', text: userText, conversationId: conv.id });
    for (const tell of heldTellsOf(tellBatches)) deps.midTurnInbox.add(conv.id, tell);
    if (!metadata?.suppressWorkerWake) await notifyFinalOutcome(conv.id, outcome);
    return outcome;
  }
  // The chain has released here. A tell that arrived during evaluation or
  // compaction becomes a new addressed send, so it cannot be stranded in the
  // inbox after the original request has settled.
  let followUpOutcome: ForgeRequestOutcome = outcome;
  try {
    for (const batch of tellBatches) {
      followUpOutcome = await send(
        batch.text,
        undefined,
        conv.id,
        {
          ...(batch.internal ? { internal: true } : {}),
          ...(batch.origin ? { origin: batch.origin } : {}),
        },
        {
          suppressWorkerWake: true,
          ...(batch.internal ? {} : { echoPrompt: true }),
        },
      );
    }
  } catch (error) {
    if (!metadata?.suppressWorkerWake) {
      await notifyFinalOutcome(conv.id, {
        kind: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
  if (!metadata?.suppressWorkerWake) {
    await notifyFinalOutcome(conv.id, followUpOutcome);
  }
  return followUpOutcome;
}

export async function notifyFinalOutcome(
  conversationId: string,
  outcome: ForgeRequestOutcome,
): Promise<void> {
  await notifyConversationSettled(conversationId, outcome);
}

function returnUndeliveredTells(
  deps: SendPipelineDeps,
  conversationId: string,
  pending: readonly TellBatch[] = [],
): void {
  const undelivered = deps.midTurnInbox.takeUndelivered(conversationId);
  const batches = [...pending, ...groupTellBatches(undelivered)];
  const userText = inputTextOf(batches);
  if (userText) deps.post({ type: 'setInput', text: userText, conversationId });
  for (const tell of heldTellsOf(batches)) deps.midTurnInbox.add(conversationId, tell);
}
