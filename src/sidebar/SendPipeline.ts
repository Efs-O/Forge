/**
 * The path from "the user pressed send" to "a turn is running": choosing the
 * conversation, refusing to overlap with one already streaming, resolving the
 * model, and the post-turn refresh.
 *
 * Split out of `SidebarProvider`. Every guard here exists because a second turn
 * on a conversation that is still streaming corrupts its transcript.
 */

import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { AttachmentData, HostToWebview } from './messageBridge';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import type { AgentLoop, SidebarProviderEvents } from './AgentLoop';
import { SessionLogCoordinator } from './SessionLogCoordinator';
import { resolveRequestModel } from '../config/ConfigResolver';
import { deriveStaticCapabilities } from '../config/ConfigResolver';
import { getLogger } from '../util/logger';
import { messageCreatedAt, type UserPromptOptions } from './transcriptMutations';
import { attachmentMediaType } from './attachmentLimits';
import { validateAttachments } from './attachmentValidation';
import type { ModelConfig } from '../config/types';
import type { RequestChainLifecycle } from './RequestChainLifecycle';
import type { RequestChainContext } from './RequestChainLifecycle';
import { toRequestOutcome, type ForgeRequestOutcome, type ForgeTurnOutcome } from './turnOutcome';
import type { AdmissionDecision, ContextThresholdAction } from './ContextBudgetPublisher';
import { isContextExhaustionReason } from '../agent/truncationRecovery';
import type { ChatAttachmentStore } from './ChatAttachmentStore';
import type { ChatAttachmentRef } from '../llm/types';
import type { MidTurnInbox } from '../agent/MidTurnInbox';
import { groupTellBatches, inputTextOf, runsAfterStop, type TellBatch } from './undeliveredTells';

const log = getLogger();
export const CONVERSATION_BUSY_ERROR = 'Forge: this conversation is still generating.';

export interface SendPipelineDeps {
  getConfig: () => ForgeConfig;
  getSidebar: () => SidebarRuntime;
  getActive: () => ConversationRuntime;
  agentLoop: AgentLoop;
  requestChains: RequestChainLifecycle;
  events: SidebarProviderEvents;
  post: (msg: HostToWebview) => void;
  persistSession: () => void;
  postSessionSync: () => void;
  evaluateAfterTurn: (
    conv: ConversationRuntime,
    chain: RequestChainContext,
    turn: ForgeTurnOutcome,
  ) => Promise<ContextThresholdAction | undefined>;
  resetContextWarning: (conversationId: string) => void;
  /** Enforces auto_compact.at on prior history before a new prompt runs. */
  evaluateAtAdmission?: (conv: ConversationRuntime) => Promise<AdmissionDecision>;
  /** Absent in tests and in a host with no globalStorage; attachments then
   *  behave exactly as before, minus the transcript thumbnails. */
  attachmentStore?: ChatAttachmentStore | undefined;
  midTurnInbox: MidTurnInbox;
}

export class SendPipeline {
  readonly sessionLogs: SessionLogCoordinator;

  constructor(private readonly deps: SendPipelineDeps) {
    this.sessionLogs = new SessionLogCoordinator(deps.getSidebar);
  }

  async send(
    text: string,
    attachments?: AttachmentData[],
    conversationId?: string,
    promptOptions?: UserPromptOptions,
    metadata?: { remoteRequestId?: string; echoPrompt?: boolean; createdAt?: number },
  ): Promise<ForgeRequestOutcome> {
    const { deps } = this;
    const refuse = (message: string, error: string, id?: string): ForgeRequestOutcome => {
      deps.post({ type: 'error', message, ...(id ? { conversationId: id } : {}) });
      return { kind: 'failed', error, finalText: '' };
    };
    const gone = 'Forge: the queued conversation is no longer open.';
    const busyAgain =
      'Forge: this conversation is still generating. Cancel it before sending again.';
    let conv = conversationId
      ? deps.getSidebar().conversations.find((candidate) => candidate.id === conversationId)
      : deps.getActive();
    if (!conv) {
      // Deliberately unaddressed: the conversation this referred to is gone, so
      // there is no tab to route it to. The active tab is the only place the
      // user can actually see it, and nothing is left streaming to clear.
      return refuse(gone, gone);
    }
    // Any sender, not only the webview, may label a text file by extension.
    attachments = attachments?.map((a) => ({
      ...a,
      mediaType: attachmentMediaType(a.name, a.mediaType),
    }));
    const attachmentError = validateAttachments(attachments);
    if (attachmentError) return refuse(attachmentError, attachmentError, conv.id);
    // Every refusal below MUST name the conversation it refers to. The webview
    // resolves an unaddressed message against the ACTIVE tab, and its ERROR
    // action clears that tab's streaming state — so a background conversation
    // failing a guard used to hide the Stop button on whichever tab the user
    // happened to be looking at, while leaving the real one streaming with no
    // way to cancel it.
    if (deps.agentLoop.isStreamingConv(conv.id) && !deps.agentLoop.isCancellationPending(conv.id)) {
      return refuse(
        'Forge: this conversation is still generating. Cancel it first or open a new tab.',
        CONVERSATION_BUSY_ERROR,
        conv.id,
      );
    }
    await deps.agentLoop.waitForCancelledTurns();
    // Everything after the await is the final preflight. No asynchronous gap
    // is allowed between these checks and the synchronous reservation below.
    conv = conversationId
      ? deps.getSidebar().conversations.find((candidate) => candidate.id === conversationId)
      : deps.getActive();
    if (!conv) return refuse(gone, gone);
    const finalAttachmentError = validateAttachments(attachments);
    if (finalAttachmentError) return refuse(finalAttachmentError, finalAttachmentError, conv.id);
    if (deps.agentLoop.isStreamingConv(conv.id)) {
      return refuse(busyAgain, CONVERSATION_BUSY_ERROR, conv.id);
    }
    const config = deps.getConfig();
    const modelName = conv.active_model ?? config.active_model;
    if (!modelName) {
      const message = 'Forge: no active model selected. Pick a model before sending.';
      deps.events.onBackendError?.(message);
      return refuse(message, message, conv.id);
    }
    // Request-time resolution: active_model may carry @profile (F6). Flattens
    // defaults + base + profile into a legacy ModelConfig for the agent loop.
    let selectedModel: ModelConfig;
    try {
      selectedModel = resolveRequestModel(config, modelName, (m) => log.info(m));
    } catch (err) {
      return refuse((err as Error).message, (err as Error).message, conv.id);
    }
    const hasImage = attachments?.some((attachment) => attachment.mediaType.startsWith('image/'));
    if (hasImage && !deriveStaticCapabilities(selectedModel).includes('vision')) {
      const refusal = `Forge: model "${selectedModel.name}" is not configured for image input.`;
      return refuse(
        `${refusal} Choose a vision-capable model. For llama.cpp, set mmproj_path to its ` +
          'compatible projector; for other providers, declare the vision capability only when ' +
          'supported.',
        refusal,
        conv.id,
      );
    }
    const admission = deps.requestChains.reserve(conv.id, () =>
      deps.agentLoop.isStreamingConv(conv.id),
    );
    if (admission.kind === 'busy') {
      return refuse(busyAgain, CONVERSATION_BUSY_ERROR, conv.id);
    }
    const chain = deps.requestChains.accept(admission.reservation, metadata?.remoteRequestId);
    const createdAt = messageCreatedAt(metadata?.createdAt);
    const initialPromptOptions = { ...(promptOptions ?? {}), createdAt };
    // Persist the full selection (incl. @profile) on the conversation so tab
    // switches restore the same profile, not just the base model (F6).
    conv.active_model = modelName;
    deps.resetContextWarning(conv.id);
    // USER_SEND covers clicks in the current webview, but auto-compaction
    // resumes, commands, and restored webviews have no such action. Announce
    // every accepted turn here so Stop does not depend on its caller.
    // A prompt the webview did not type has no user bubble yet: only the
    // webview's own send dispatches one. Posted before generationStarted so the
    // transcript reads in the order it happened, and only when the caller asks
    // -- a webview send would otherwise render its prompt twice.
    if (metadata?.echoPrompt) {
      deps.post({
        type: 'userPrompt',
        text,
        createdAt,
        conversationId: conv.id,
        ...(promptOptions?.sender ? { sender: promptOptions.sender } : {}),
        ...(attachments?.length ? { attachments } : {}),
      });
    }
    deps.post({ type: 'generationStarted', conversationId: conv.id });
    // Saved before the turn, so the reference is already on the user message the
    // first time the transcript is persisted. A failure here must not cost the
    // user their prompt: the turn runs without thumbnails instead.
    let attachmentRefs: ChatAttachmentRef[] = [];
    if (attachments?.length && deps.attachmentStore) {
      try {
        const saved = await deps.attachmentStore.save(conv.id, attachments);
        attachmentRefs = saved.refs;
        if (saved.failures.length) {
          const names = saved.failures.map((failure) => failure.name).join(', ');
          log.warn(`[SendPipeline] chat attachment failures: ${JSON.stringify(saved.failures)}`);
          deps.post({
            type: 'notice',
            severity: 'warning',
            message: `Some attachment thumbnails could not be saved: ${names}. The turn will continue with the attached files.`,
            conversationId: conv.id,
          });
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const filenames = attachments.map((attachment) => attachment.name).join(', ');
        log.warn(`[SendPipeline] chat attachments were not saved: ${detail}`);
        deps.post({
          type: 'notice',
          severity: 'warning',
          message: `Attachment thumbnails could not be saved: ${filenames}. The turn will continue with the attached files.`,
          conversationId: conv.id,
        });
      }
    }
    // Closing or deleting the chat during either await above or the admission
    // check below invalidates the chain; it must not reach runTurn. A Stop then
    // only marks the chain (no turn to abort): stoppedBeforeTurn honours it.
    if (!deps.requestChains.isCurrent(chain)) return { kind: 'cancelled' };
    let outcome: ForgeRequestOutcome;
    const pendingTellBatches: TellBatch[] = [];
    // Set when "Send now" interrupted the turn: its batches run after release.
    let sendNowHeld = false;
    try {
      outcome = await deps.requestChains.run(chain, async () => {
        const stoppedBeforeTurn = (): ForgeRequestOutcome | undefined => {
          const kind = deps.requestChains.terminationKind(chain);
          if (!kind) return undefined;
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
            deps.post({ type: 'setInput', text, conversationId: conv.id });
            deps.post({ type: 'done', finishReason: 'stop', conversationId: conv.id });
            return { kind: 'failed', error: decision.reason };
          }
          if (!deps.requestChains.isCurrent(chain)) return { kind: 'cancelled' };
          const stoppedAtAdmission = stoppedBeforeTurn();
          if (stoppedAtAdmission) return stoppedAtAdmission;
        }
        for (;;) {
          let turn: ForgeTurnOutcome;
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
            this.sessionLogs.flushSessionLog(conv.id);
          }
          // After the flush, so the error lands beneath the rows it followed. A
          // failed turn writes no messages of its own, so without this the file
          // ends on the last successful tool row and reads as a healthy turn.
          if (turn.kind === 'failed') this.sessionLogs.logTurnError(conv.id, turn.error);
          if (turn.kind === 'cancelled' || turn.kind === 'interrupted') {
            this.sessionLogs.logTurnStopped(conv.id, turn.kind);
          }
          const undelivered = deps.midTurnInbox.takeUndelivered(conv.id);
          pendingTellBatches.push(...groupTellBatches(undelivered));
          if (pendingTellBatches.length > 0) {
            if (turn.kind === 'cancelled' || turn.kind === 'interrupted') {
              sendNowHeld = runsAfterStop(turn.kind, undelivered);
              const userText = sendNowHeld ? undefined : inputTextOf(pendingTellBatches);
              if (userText)
                deps.post({ type: 'setInput', text: userText, conversationId: conv.id });
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
          if (turn.kind !== 'completed' && !recoverableContextFailure)
            return toRequestOutcome(turn);
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
      this.returnUndeliveredTells(conv.id);
      throw error;
    }
    const undeliveredAfterRelease = deps.midTurnInbox.takeUndelivered(conv.id);
    const tellBatches = [
      ...(sendNowHeld ? pendingTellBatches : []),
      ...groupTellBatches(undeliveredAfterRelease),
    ];
    if (tellBatches.length === 0) return outcome;
    const stopped = outcome.kind === 'cancelled' || outcome.kind === 'interrupted';
    if (stopped && !sendNowHeld && !runsAfterStop(outcome.kind, undeliveredAfterRelease)) {
      const userText = inputTextOf(tellBatches);
      if (userText) deps.post({ type: 'setInput', text: userText, conversationId: conv.id });
      return outcome;
    }
    // The chain has released here. A tell that arrived during evaluation or
    // compaction becomes a new addressed send, so it cannot be stranded in the
    // inbox after the original request has settled.
    let followUpOutcome: ForgeRequestOutcome = outcome;
    for (const batch of tellBatches) {
      followUpOutcome = await this.send(
        batch.text,
        undefined,
        conv.id,
        batch.internal ? { internal: true } : undefined,
        batch.internal ? undefined : { echoPrompt: true },
      );
    }
    return followUpOutcome;
  }

  private returnUndeliveredTells(conversationId: string): void {
    const undelivered = this.deps.midTurnInbox.takeUndelivered(conversationId);
    if (undelivered.length === 0) return;
    this.deps.post({
      type: 'setInput',
      text: undelivered.map((tell) => tell.text).join('\n\n'),
      conversationId,
    });
  }

  /**
   * A prompt from outside the webview (a command, another extension). Unlike a
   * webview send it *throws* rather than posting, because the caller is code
   * that needs to know, and it reveals the sidebar first so the user sees the
   * turn they just triggered.
   */
  async submitExternal(text: string, attachments?: AttachmentData[]): Promise<void> {
    const { deps } = this;
    const activeId = deps.getSidebar().activeConversationId;
    if (
      deps.agentLoop.isStreamingConv(activeId) &&
      !deps.agentLoop.isCancellationPending(activeId)
    ) {
      throw new Error(
        'Forge: this conversation is still generating. Switch to it and cancel, or open a new tab.',
      );
    }
    await deps.agentLoop.waitForCancelledTurns();
    if (deps.agentLoop.isStreamingConv(activeId)) {
      throw new Error(
        'Forge: this conversation is still generating. Cancel it before sending again.',
      );
    }
    await vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
    // Same hole as a remote prompt: a command-issued prompt is not typed in the
    // webview, so nothing else would draw its bubble.
    await this.send(text, attachments, undefined, undefined, { echoPrompt: true });
  }
}
