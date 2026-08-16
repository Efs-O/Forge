/**
 * The collaborators every kind of turn needs, assembled once by `AgentLoop`.
 *
 * Each turn module (`ModelTurn`, `CliTurn`, `WorkerTurn`, `ProviderTurn`,
 * `PromptRun`) declares the narrower slice it actually uses; this is the
 * superset that satisfies all of them, so AgentLoop hands the same object to
 * each instead of rebuilding a bespoke context per call.
 */

import type * as vscode from 'vscode';
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { AttachmentData, HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { IBackendPool } from '../backend/BackendPool';
import type { CheckpointStack, CheckpointSession } from '../checkpoint/CheckpointStack';
import type { RuntimeModelCapabilities } from '../backend/ModelCapabilities';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolFailureTracker } from '../tools/StripTools';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import type { CliAgentDriver } from '../agents/CliAgentDriver';
import type { CliSessionRegistry } from '../agents/CliSessionRegistry';
import type { WorkerOrchestrationService } from '../workers/WorkerOrchestrationService';
import type { ToolApprovalService } from './ToolApprovalService';
import type { ToolDispatch } from './ToolDispatch';
import type { TurnLifecycle } from './TurnLifecycle';
import type { SidebarProviderEvents } from './AgentLoop';

export interface TurnServices {
  pool: IBackendPool;
  getConfig: () => ForgeConfig;
  toolRegistry: ToolRegistry;
  toolDispatch: ToolDispatch;
  failureTracker: ToolFailureTracker;
  approvals: ToolApprovalService;
  workerService: WorkerOrchestrationService;
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
  onContextChanged: (convId: string, promptChanged: boolean) => void;
  onExactContextTokens: (convId: string, usedTokens: number) => void;
  commitUserPrompt: (
    conv: ConversationRuntime,
    text: string,
    attachments?: AttachmentData[],
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
  waitForCancelledTurns: () => Promise<void>;
  setController: (ctrl: AbortController) => void;
  releaseController: (ctrl: AbortController) => void;
}
