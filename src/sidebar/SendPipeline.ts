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
import type { ForgeRequestOutcome, ForgeTurnOutcome } from './turnOutcome';
import type { AdmissionDecision, ContextThresholdAction } from './ContextBudgetPublisher';
import type { ChatAttachmentStore } from './ChatAttachmentStore';
import type { ChatAttachmentRef } from '../llm/types';
import type { MidTurnInbox } from '../agent/MidTurnInbox';
import { notifyFinalOutcome, runSendChain } from './sendChainExecution';

const log = getLogger();
export const CONVERSATION_BUSY_ERROR = 'Forge: this conversation is still generating.';
export const CONVERSATION_GONE_ERROR = 'Forge: the queued conversation is no longer open.'; // `RemoteQueueDrain.ts` answers this one with what to send next: "the queued conversation" is nothing on a handset.

/** How the send was asked for, and what its caller wants from the settle. */
export interface SendRequestMetadata {
  remoteRequestId?: string;
  echoPrompt?: boolean;
  createdAt?: number;
  /** Called after backend startup and prompt commit, before model completion. */
  onAdmitted?: () => void;
  /** Nested tell sends share their parent's final wake. */
  suppressWorkerWake?: boolean;
}

export interface SendPipelineDeps {
  getConfig: () => ForgeConfig;
  getSidebar: () => SidebarRuntime;
  getActive: () => ConversationRuntime;
  agentLoop: AgentLoop;
  requestChains: RequestChainLifecycle;
  events: SidebarProviderEvents;
  post: (msg: HostToWebview) => void;
  persistSession: (changedId?: string) => void | Promise<boolean>;
  onConversationActivity?: (conversationId: string) => void;
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
    this.sessionLogs = new SessionLogCoordinator(deps.getSidebar, deps.getConfig);
  }

  async send(
    text: string,
    attachments?: AttachmentData[],
    conversationId?: string,
    promptOptions?: UserPromptOptions,
    metadata?: SendRequestMetadata,
  ): Promise<ForgeRequestOutcome> {
    const { deps } = this;
    const refuse = (message: string, error: string, id?: string): ForgeRequestOutcome => {
      deps.post({ type: 'error', message, ...(id ? { conversationId: id } : {}) });
      return { kind: 'failed', error, finalText: '' };
    };
    const busyAgain =
      'Forge: this conversation is still generating. Cancel it before sending again.';
    let conv = conversationId
      ? deps.getSidebar().conversations.find((candidate) => candidate.id === conversationId)
      : deps.getActive();
    if (!conv) {
      // Deliberately unaddressed: the conversation this referred to is gone, so
      // there is no tab to route it to. The active tab is the only place the
      // user can actually see it, and nothing is left streaming to clear.
      return refuse(CONVERSATION_GONE_ERROR, CONVERSATION_GONE_ERROR);
    }
    // Any sender, not only the webview, may label a text file by extension.
    attachments = attachments?.map((a) => ({
      ...a,
      mediaType: attachmentMediaType(a.name, a.mediaType),
    }));
    const attachmentError = validateAttachments(attachments);
    if (attachmentError) return refuse(attachmentError, attachmentError, conv.id);
    // Address every refusal: an unaddressed ERROR clears the visible tab's
    // streaming state and strands the background tab without Stop.
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
    if (!conv) return refuse(CONVERSATION_GONE_ERROR, CONVERSATION_GONE_ERROR);
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
    deps.onConversationActivity?.(conv.id);
    const createdAt = messageCreatedAt(metadata?.createdAt);
    const initialPromptOptions = {
      ...(promptOptions ?? {}),
      createdAt,
      ...(metadata?.onAdmitted ? { onStarted: metadata.onAdmitted } : {}),
    };
    // Preserve @profile across tab switches (F6).
    conv.active_model = modelName;
    deps.resetContextWarning(conv.id);
    // External prompts need a bubble before generationStarted; webview sends
    // already rendered theirs. Every sender needs generationStarted for Stop.
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
    if (!deps.requestChains.isCurrent(chain)) {
      const outcome: ForgeRequestOutcome = { kind: 'cancelled' };
      if (!metadata?.suppressWorkerWake) await notifyFinalOutcome(conv.id, outcome);
      return outcome;
    }
    return runSendChain({
      deps,
      sessionLogs: this.sessionLogs,
      conv,
      chain,
      selectedModel,
      text,
      attachments,
      promptOptions,
      metadata,
      attachmentRefs,
      initialPromptOptions,
      send: (nextText, nextAttachments, nextId, nextOptions, nextMetadata) =>
        this.send(nextText, nextAttachments, nextId, nextOptions, nextMetadata),
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
