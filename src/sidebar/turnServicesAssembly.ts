/**
 * Assembles the `TurnServices` object `AgentLoop` hands to every turn module.
 *
 * Extracted from the `AgentLoop` constructor (pure move — no behaviour change).
 * The constructor still owns the collaborators; this module only packages them
 * into the services object, including the late-bound wrappers for the listeners
 * that are registered after construction.
 *
 * The new module imports `AgentLoop` only as a type (never as a value), so no
 * value-import cycle is introduced.
 */

import type * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { IBackendPool } from '../backend/BackendPool';
import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolFailureTracker } from '../tools/StripTools';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import type { CliAgentDriver } from '../agents/CliAgentDriver';
import type { CliSessionRegistry } from '../agents/CliSessionRegistry';
import type { ToolApprovalService } from './ToolApprovalService';
import type { ToolDispatch } from './ToolDispatch';
import type { TurnLifecycle } from './TurnLifecycle';
import type { SidebarProviderEvents } from './providerEvents';
import type { CapabilityCache } from './CapabilityCache';
import type { AgentProgressEvent } from './AgentProgress';
import type { AttachmentData } from './messageBridge';
import type { UserPromptOptions } from './transcriptMutations';
import { applyUsage } from './transcriptMutations';
import { makeRunModelTurn } from './turnServices';
import type { TurnServices, MidTurnTellServices } from './turnServices';
import { runModelTurn } from './ModelTurn';

/**
 * The slice of `AgentLoop` the services assembly needs. The lazily-registered
 * listeners are exposed as getters so the wrappers read the current value at
 * call time (they are wired after construction).
 */
export interface TurnServicesAssembly {
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
  capabilities: CapabilityCache;
  promptRunControllers: Map<AbortController, string | undefined>;
  secrets?: vscode.SecretStorage;
  templateEngine?: TemplateEngine;
  forgeLoader?: ForgeInstructionsLoader;
  cliDriver?: CliAgentDriver;
  getConfigPath?: () => string;
  /** Registered after construction — read at call time. */
  getOnContextChanged: () => ((convId: string) => void) | undefined;
  /** Registered after construction and only while a transport is running. */
  getRemoteReach: () => ((conversationId: string) => number) | undefined;
  getMidTurnCompactor: () => TurnServices['compactMidTurn'];
  getMidTurnTells: () => MidTurnTellServices | undefined;
  warnOnce: (key: string, message: string) => void;
  recordTranscriptMutation: (conv: ConversationRuntime) => void;
  emitAgentProgress: (event: AgentProgressEvent) => void;
  commitUserPrompt: (
    conv: ConversationRuntime,
    text: string,
    attachments?: AttachmentData[],
    options?: UserPromptOptions,
  ) => void;
  waitForCancelledTurns: () => Promise<void>;
}

/**
 * Builds the `TurnServices` object. `runModelTurn` is wired last: it holds the
 * services object itself, so it cannot be captured while the object is still
 * being built (the late `getServices` thunk reads it on call).
 */
export function buildTurnServices(d: TurnServicesAssembly): TurnServices {
  const services: Omit<TurnServices, 'runModelTurn'> = {
    pool: d.pool,
    getConfig: d.getConfig,
    toolRegistry: d.toolRegistry,
    toolDispatch: d.toolDispatch,
    failureTracker: d.failureTracker,
    approvals: d.approvals,
    checkpoints: d.checkpoints,
    lifecycle: d.lifecycle,
    events: d.events,
    post: d.post,
    workspaceRoot: d.workspaceRoot,
    cliSessions: d.cliSessions,
    ...(d.secrets ? { secrets: d.secrets } : {}),
    ...(d.templateEngine ? { templateEngine: d.templateEngine } : {}),
    ...(d.forgeLoader ? { forgeLoader: d.forgeLoader } : {}),
    ...(d.cliDriver ? { cliDriver: d.cliDriver } : {}),
    ...(d.getConfigPath ? { getConfigPath: d.getConfigPath } : {}),
    capabilities: (model, baseUrl) => d.capabilities.get(model, baseUrl),
    warnOnce: (key, message) => d.warnOnce(key, message),
    // Wrapped rather than passed: both listeners are registered after
    // construction, so a snapshot taken here would capture undefined.
    onContextChanged: (convId) => d.getOnContextChanged()?.(convId),
    onUsage: (conv, inputTokens, outputTokens) => {
      applyUsage(conv, inputTokens, outputTokens);
      d.recordTranscriptMutation(conv);
    },
    onTranscriptChanged: (conv) => d.recordTranscriptMutation(conv),
    emitAgentProgress: (event) => d.emitAgentProgress(event),
    // Wrapped, not snapshotted, for the reason above: the probe is
    // registered after construction and only while a transport is running.
    remoteReach: (conversationId) => d.getRemoteReach()?.(conversationId) ?? 0,
    compactMidTurn: (conv, request) =>
      d.getMidTurnCompactor()?.(conv, request) ?? Promise.resolve(false),
    drainTells: (id) => d.getMidTurnTells()?.drainTells(id) ?? Promise.resolve({ messages: [] }),
    onTellArrived: (id, callback) => d.getMidTurnTells()?.onTellArrived(id, callback) ?? (() => {}),
    // `options` is load-bearing and was missing here: a narrower function is
    // assignable, so dropping the 4th parameter type-checked while silently
    // discarding `internal: true`. Every Forge-authored prompt — the
    // compaction resume above all — was then indistinguishable from something
    // the user typed, and `collectCompactionUserMessages` carried the resume
    // prompt forward as a verbatim user request.
    commitUserPrompt: (conv, text, attachments, options) =>
      d.commitUserPrompt(conv, text, attachments, options),
    waitForCancelledTurns: () => d.waitForCancelledTurns(),
    setController: (ctrl, conversationId) => {
      d.promptRunControllers.set(ctrl, conversationId);
    },
    releaseController: (ctrl) => {
      d.promptRunControllers.delete(ctrl);
    },
  };
  const full = {
    ...services,
    runModelTurn: makeRunModelTurn(() => full, runModelTurn),
  } as TurnServices;
  return full;
}
