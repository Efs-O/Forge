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
import { getLogger } from '../util/logger';
import type { UserPromptOptions } from './transcriptMutations';

const log = getLogger();

export interface SendPipelineDeps {
  getConfig: () => ForgeConfig;
  getSidebar: () => SidebarRuntime;
  getActive: () => ConversationRuntime;
  agentLoop: AgentLoop;
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
  ): Promise<void> {
    const { deps } = this;
    const conv = conversationId
      ? deps.getSidebar().conversations.find((candidate) => candidate.id === conversationId)
      : deps.getActive();
    if (!conv) {
      // Deliberately unaddressed: the conversation this referred to is gone, so
      // there is no tab to route it to. The active tab is the only place the
      // user can actually see it, and nothing is left streaming to clear.
      deps.post({ type: 'error', message: 'Forge: the queued conversation is no longer open.' });
      return;
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
      return;
    }
    await deps.agentLoop.waitForCancelledTurns();
    if (deps.agentLoop.isStreamingConv(conv.id)) {
      deps.post({
        type: 'error',
        message: 'Forge: this conversation is still generating. Cancel it before sending again.',
        conversationId: conv.id,
      });
      return;
    }
    const config = deps.getConfig();
    const modelName = conv.active_model ?? config.active_model;
    if (!modelName) {
      const message = 'Forge: no active model selected. Pick a model before sending.';
      deps.events.onBackendError?.(message);
      deps.post({ type: 'error', message, conversationId: conv.id });
      return;
    }
    // Request-time resolution: active_model may carry @profile (F6). Flattens
    // defaults + base + profile into a legacy ModelConfig for the agent loop.
    let selectedModel;
    try {
      selectedModel = resolveRequestModel(config, modelName, (m) => log.info(m));
    } catch (err) {
      deps.post({ type: 'error', message: (err as Error).message, conversationId: conv.id });
      return;
    }
    // Persist the full selection (incl. @profile) on the conversation so tab
    // switches restore the same profile, not just the base model (F6).
    conv.active_model = modelName;
    deps.resetContextWarning();
    // USER_SEND covers clicks in the current webview, but auto-compaction
    // resumes, commands, and restored webviews have no such action. Announce
    // every accepted turn here so Stop does not depend on its caller.
    deps.post({ type: 'generationStarted', conversationId: conv.id });
    try {
      await deps.agentLoop.runTurn(conv, selectedModel, text, attachments, promptOptions);
    } finally {
      deps.failureTracker.reset();
      deps.persistSession();
      deps.postSessionSync();
      deps.postTokenBudget(true);
      this.flushSessionLog(conv.id);
    }
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
      this.sessionLoggers.set(
        convId,
        new SessionLogger(convId, conv.title, conv.active_model ?? ''),
      );
    }
    const logger = this.sessionLoggers.get(convId)!;
    logger.updateTitle(conv.title);
    logger.flush(conv.messages, conv.active_model ?? '');
  }
}
