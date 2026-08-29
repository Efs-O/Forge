/**
 * The collaborators every kind of turn needs, assembled once by `AgentLoop`.
 *
 * Each turn module (`ModelTurn`, `CliTurn`, `ProviderTurn`,
 * `PromptRun`) declares the narrower slice it actually uses; this is the
 * superset that satisfies all of them, so AgentLoop hands the same object to
 * each instead of rebuilding a bespoke context per call.
 */

import type * as vscode from 'vscode';
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { AttachmentData, HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { ModelTurnRequest } from './ModelTurn';
import type { ToolCallingLoopResult } from '../agent/ToolCallingLoop';
import type { IBackendPool } from '../backend/BackendPool';
import type { CheckpointStack, CheckpointSession } from '../checkpoint/CheckpointStack';
import type { RuntimeModelCapabilities } from '../backend/ModelCapabilities';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolFailureTracker } from '../tools/StripTools';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import type { CliAgentDriver } from '../agents/CliAgentDriver';
import type { CliSessionRegistry } from '../agents/CliSessionRegistry';
import type { ToolApprovalService } from './ToolApprovalService';
import type { ToolDispatch } from './ToolDispatch';
import type { TurnLifecycle } from './TurnLifecycle';
import type { SidebarProviderEvents } from './AgentLoop';
import type { UserPromptOptions } from './transcriptMutations';

export interface TurnServices {
  pool: IBackendPool;
  getConfig: () => ForgeConfig;
  toolRegistry: ToolRegistry;
  toolDispatch: ToolDispatch;
  failureTracker: ToolFailureTracker;
  approvals: ToolApprovalService;
  checkpoints: CheckpointStack;
  lifecycle: TurnLifecycle;
  events: SidebarProviderEvents;
  post: (msg: HostToWebview) => void;
  workspaceRoot: string;
  cliSessions: CliSessionRegistry;
  secrets?: vscode.SecretStorage;
  templateEngine?: TemplateEngine;
  forgeLoader?: ForgeInstructionsLoader;
  cliDriver?: CliAgentDriver;
  getConfigPath?: () => string;
  capabilities: (model: ModelConfig, baseUrl: string) => Promise<RuntimeModelCapabilities>;
  warnOnce: (key: string, message: string) => void;
  onContextChanged: (convId: string) => void;
  onUsage: (conv: ConversationRuntime, inputTokens: number, outputTokens: number) => void;
  /** Persists a transcript mutation immediately, including an in-flight turn. */
  onTranscriptChanged: (conv: ConversationRuntime) => void;
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
  ) => Promise<ToolCallingLoopResult>;
  waitForCancelledTurns: () => Promise<void>;
  /** Associates an out-of-band model request with its owning conversation when
   * one exists, so that tab's Stop action can abort it. */
  setController: (ctrl: AbortController, conversationId?: string) => void;
  releaseController: (ctrl: AbortController) => void;
}

/**
 * Adapt `runModelTurn`'s positional signature to the options object the turn
 * module takes. `getServices` is called late: the services object holds this
 * very function, so it cannot be captured while it is still being built.
 */
export function makeRunModelTurn(
  getServices: () => TurnServices,
  run: (services: TurnServices, options: ModelTurnRequest) => Promise<ToolCallingLoopResult>,
): TurnServices['runModelTurn'] {
  return (baseUrl, conv, model, activeFile, ctrl, postC, apiKey, checkpoint) =>
    run(getServices(), {
      baseUrl,
      conv,
      model,
      activeFile,
      ctrl,
      postC,
      ...(apiKey ? { apiKey } : {}),
      checkpoint,
    });
}
