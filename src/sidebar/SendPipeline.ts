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
import type { ToolFailureTracker } from '../tools/StripTools';
import type { AgentLoop, SidebarProviderEvents } from './AgentLoop';
import { SessionLogger } from './SessionLogger';
import { resolveRequestModel } from '../config/ConfigResolver';
import { deriveStaticCapabilities } from '../config/ConfigResolver';
import { getLogger } from '../util/logger';
import type { UserPromptOptions } from './transcriptMutations';
import { validateAttachments } from './attachmentValidation';
import type { ModelConfig } from '../config/types';
import type { RequestChainLifecycle } from './RequestChainLifecycle';
import { toRequestOutcome, type ForgeRequestOutcome } from './turnOutcome';

const log = getLogger();

/** Undefined outside a real host (tests, or an unresolvable extension id). */
function forgeVersion(): string | undefined {
  const version = vscode.extensions.getExtension('Efsoo.forge-llm')?.packageJSON?.['version'];
  return typeof version === 'string' ? version : undefined;
}

export interface SendPipelineDeps {
  getConfig: () => ForgeConfig;
  getSidebar: () => SidebarRuntime;
  getActive: () => ConversationRuntime;
  agentLoop: AgentLoop;
  requestChains: RequestChainLifecycle;
  failureTracker: ToolFailureTracker;
  events: SidebarProviderEvents;
  post: (msg: HostToWebview) => void;
  persistSession: () => void;
  postSessionSync: () => void;
  /** Republishes the budget; `true` lets it act on the warning/compact thresholds. */
  postTokenBudget: (evaluateThresholds?: boolean) => void;
  resetContextWarning: () => void;
}

export class SendPipeline {
  private readonly sessionLoggers = new Map<string, SessionLogger>();

  constructor(private readonly deps: SendPipelineDeps) {}

  async send(
    text: string,
    attachments?: AttachmentData[],
    conversationId?: string,
    promptOptions?: UserPromptOptions,
  ): Promise<ForgeRequestOutcome> {
    const { deps } = this;
    let conv = conversationId
      ? deps.getSidebar().conversations.find((candidate) => candidate.id === conversationId)
      : deps.getActive();
    if (!conv) {
      // Deliberately unaddressed: the conversation this referred to is gone, so
      // there is no tab to route it to. The active tab is the only place the
      // user can actually see it, and nothing is left streaming to clear.
      deps.post({ type: 'error', message: 'Forge: the queued conversation is no longer open.' });
      return {
        kind: 'failed',
        error: 'Forge: the queued conversation is no longer open.',
        finalText: '',
      };
    }
    const attachmentError = validateAttachments(attachments);
    if (attachmentError) {
      deps.post({ type: 'error', message: attachmentError, conversationId: conv.id });
      return { kind: 'failed', error: attachmentError, finalText: '' };
    }
    // Every refusal below MUST name the conversation it refers to. The webview
    // resolves an unaddressed message against the ACTIVE tab, and its ERROR
    // action clears that tab's streaming state — so a background conversation
    // failing a guard used to hide the Stop button on whichever tab the user
    // happened to be looking at, while leaving the real one streaming with no
    // way to cancel it.
    if (deps.agentLoop.isStreamingConv(conv.id) && !deps.agentLoop.isCancellationPending(conv.id)) {
      deps.post({
        type: 'error',
        message: 'Forge: this conversation is still generating. Cancel it first or open a new tab.',
        conversationId: conv.id,
      });
      return {
        kind: 'failed',
        error: 'Forge: this conversation is still generating.',
        finalText: '',
      };
    }
    await deps.agentLoop.waitForCancelledTurns();
    // Everything after the await is the final preflight. No asynchronous gap
    // is allowed between these checks and the synchronous reservation below.
    conv = conversationId
      ? deps.getSidebar().conversations.find((candidate) => candidate.id === conversationId)
      : deps.getActive();
    if (!conv) {
      deps.post({ type: 'error', message: 'Forge: the queued conversation is no longer open.' });
      return {
        kind: 'failed',
        error: 'Forge: the queued conversation is no longer open.',
        finalText: '',
      };
    }
    const finalAttachmentError = validateAttachments(attachments);
    if (finalAttachmentError) {
      deps.post({ type: 'error', message: finalAttachmentError, conversationId: conv.id });
      return { kind: 'failed', error: finalAttachmentError, finalText: '' };
    }
    if (deps.agentLoop.isStreamingConv(conv.id)) {
      deps.post({
        type: 'error',
        message: 'Forge: this conversation is still generating. Cancel it before sending again.',
        conversationId: conv.id,
      });
      return {
        kind: 'failed',
        error: 'Forge: this conversation is still generating.',
        finalText: '',
      };
    }
    const config = deps.getConfig();
    const modelName = conv.active_model ?? config.active_model;
    if (!modelName) {
      const message = 'Forge: no active model selected. Pick a model before sending.';
      deps.events.onBackendError?.(message);
      deps.post({ type: 'error', message, conversationId: conv.id });
      return { kind: 'failed', error: message, finalText: '' };
    }
    // Request-time resolution: active_model may carry @profile (F6). Flattens
    // defaults + base + profile into a legacy ModelConfig for the agent loop.
    let selectedModel: ModelConfig;
    try {
      selectedModel = resolveRequestModel(config, modelName, (m) => log.info(m));
    } catch (err) {
      deps.post({ type: 'error', message: (err as Error).message, conversationId: conv.id });
      return { kind: 'failed', error: (err as Error).message, finalText: '' };
    }
    const hasImage = attachments?.some((attachment) => attachment.mediaType.startsWith('image/'));
    if (hasImage && !deriveStaticCapabilities(selectedModel).includes('vision')) {
      deps.post({
        type: 'error',
        message:
          `Forge: model "${selectedModel.name}" is not configured for image input. ` +
          'Choose a vision-capable model. For llama.cpp, set mmproj_path to its compatible ' +
          'projector; for other providers, declare the vision capability only when supported.',
        conversationId: conv.id,
      });
      return {
        kind: 'failed',
        error: `Forge: model "${selectedModel.name}" is not configured for image input.`,
        finalText: '',
      };
    }
    const admission = deps.requestChains.reserve(conv.id, () =>
      deps.agentLoop.isStreamingConv(conv.id),
    );
    if (admission.kind === 'busy') {
      deps.post({
        type: 'error',
        message: 'Forge: this conversation is still generating. Cancel it before sending again.',
        conversationId: conv.id,
      });
      return {
        kind: 'failed',
        error: 'Forge: this conversation is still generating.',
        finalText: '',
      };
    }
    const chain = deps.requestChains.accept(admission.reservation);
    // Persist the full selection (incl. @profile) on the conversation so tab
    // switches restore the same profile, not just the base model (F6).
    conv.active_model = modelName;
    deps.resetContextWarning();
    // USER_SEND covers clicks in the current webview, but auto-compaction
    // resumes, commands, and restored webviews have no such action. Announce
    // every accepted turn here so Stop does not depend on its caller.
    deps.post({ type: 'generationStarted', conversationId: conv.id });
    return deps.requestChains.run(chain, async () => {
      try {
        const turn = await deps.agentLoop.runTurn(
          conv,
          selectedModel,
          text,
          attachments,
          promptOptions,
        );
        return toRequestOutcome(turn);
      } finally {
        deps.failureTracker.reset();
        deps.persistSession();
        deps.postSessionSync();
        deps.postTokenBudget(true);
        this.flushSessionLog(conv.id);
      }
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
    await this.send(text, attachments);
  }

  /** Appends the finished turn to the on-disk transcript under ~/.forge. */
  private flushSessionLog(convId: string): void {
    const conv = this.deps.getSidebar().conversations.find((c) => c.id === convId);
    if (!conv || conv.messages.length === 0) return;
    if (!this.sessionLoggers.has(convId)) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      this.sessionLoggers.set(
        convId,
        new SessionLogger(convId, conv.title, conv.active_model ?? '', {
          ...(folder ? { workspaceName: folder.name, workspacePath: folder.uri.fsPath } : {}),
          ...(forgeVersion() ? { forgeVersion: forgeVersion()! } : {}),
        }),
      );
    }
    const logger = this.sessionLoggers.get(convId)!;
    logger.updateTitle(conv.title);
    logger.flush(conv.messages, conv.active_model ?? '', {
      inputTokens: conv.input_tokens ?? 0,
      outputTokens: conv.output_tokens ?? 0,
      requestCount: conv.model_request_count ?? 0,
      ...(conv.active_time_ms !== undefined ? { activeTimeMs: conv.active_time_ms } : {}),
    });
  }
}
