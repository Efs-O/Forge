/**
 * A turn served by a local CLI agent (claude, codex) rather than a model
 * endpoint.
 *
 * Split out of `AgentLoop`: it shares the turn lifecycle and checkpointing but
 * none of the request building — there is no context window to budget, no tool
 * registry to advertise, and the agent owns its own loop.
 */

import type { ModelConfig } from '../config/types';
import type { AttachmentData, HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import type { CliAgentDriver } from '../agents/CliAgentDriver';
import type { CliSessionRegistry } from '../agents/CliSessionRegistry';
import { prepareCliChatAgent, runCliChat, runWarmCliChat } from '../agents/CliChatRunner';
import { recordModelUsage } from './modelManager/usageTracker';
import type { SidebarProviderEvents } from './AgentLoop';
import type { TurnLifecycle } from './TurnLifecycle';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface CliTurnContext {
  workspaceRoot: string;
  lifecycle: TurnLifecycle;
  checkpoints: CheckpointStack;
  events: SidebarProviderEvents;
  cliSessions: CliSessionRegistry;
  cliDriver?: CliAgentDriver;
  getConfigPath?: () => string;
  /** Appends the user's message and titles the conversation on the first one. */
  commitUserPrompt: (
    conv: ConversationRuntime,
    text: string,
    attachments?: AttachmentData[],
  ) => void;
  onTranscriptChanged: (conv: ConversationRuntime) => void;
}

export async function runCliTurn(
  ctx: CliTurnContext,
  conv: ConversationRuntime,
  model: ModelConfig,
  text: string,
  attachments: AttachmentData[] | undefined,
  postC: (msg: HostToWebview) => void,
): Promise<void> {
  const convId = conv.id;
  // Only the first prompt in a conversation actually starts the CLI agent;
  // later turns resume the warm session, so suppress the start/ready chatter.
  const firstCliPrompt = !conv.cli_sessions?.[model.name];
  let prepared;
  try {
    if (firstCliPrompt) postC({ type: 'backendStarting', message: `Starting ${model.name}…` });
    prepared = await prepareCliChatAgent(model, ctx.workspaceRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.events.onBackendError?.(message);
    postC({ type: 'backendDown', message });
    return;
  }

  const ctrl = new AbortController();
  ctx.lifecycle.register(convId, ctrl);
  conv.active_model ??= model.name;
  conv.updatedAt = Date.now();
  const configPath = ctx.getConfigPath?.();
  if (configPath) recordModelUsage(configPath, model.name);

  const checkpoint = ctx.checkpoints.beginTurn(`cli-chat-${Date.now()}`, convId);
  ctx.lifecycle.markStreaming(convId);
  let generationStarted = false;

  try {
    const sessionId = conv.cli_sessions?.[model.name];
    const common = {
      prepared,
      model,
      messages: conv.messages,
      workspaceRoot: ctx.workspaceRoot,
      checkpoint,
      signal: ctrl.signal,
      onText: (chunk: string) => postC({ type: 'token', text: chunk }),
      onStatus: (detail: string) =>
        postC({ type: 'toolActivity', toolName: prepared.cliName, detail }),
      onPrepared: () => {
        ctx.commitUserPrompt(conv, text, attachments);
        generationStarted = true;
        ctx.events.onBackendReady?.(model.name);
        ctx.events.onGenerationStarted?.(model.name);
        if (firstCliPrompt) postC({ type: 'ready' });
        postC({ type: 'generationStarted' });
      },
      announceRollback: firstCliPrompt,
      ...(sessionId ? { sessionId } : {}),
    };
    const result = ctx.cliDriver
      ? await runCliChat({ ...common, driver: ctx.cliDriver })
      : await runWarmCliChat({
          ...common,
          registry: ctx.cliSessions,
          key: { conversationId: conv.id, modelName: model.name },
        });
    if (result.sessionId) {
      conv.cli_sessions = { ...conv.cli_sessions, [model.name]: result.sessionId };
      ctx.onTranscriptChanged(conv);
    }
    if (result.assistantText) {
      conv.messages.push({ role: 'assistant', content: result.assistantText });
      ctx.onTranscriptChanged(conv);
    }
    if (result.status !== 'completed' && result.status !== 'cancelled') {
      postC({ type: 'error', message: result.error ?? `${model.name} failed.` });
    }
    postC({
      type: 'done',
      finishReason: result.status === 'completed' ? 'stop' : result.status,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[AgentLoop] cli chat failed model=${model.name}: ${message}`);
    ctx.events.onBackendError?.(message);
    postC({ type: 'error', message });
    postC({ type: 'done', finishReason: 'error' });
  } finally {
    ctx.lifecycle.clearStreaming(convId);
    conv.updatedAt = Date.now();
    const depthBefore = ctx.checkpoints.depth(convId);
    ctx.checkpoints.commitTurn(checkpoint);
    if (ctx.checkpoints.depth(convId) > depthBefore) postC({ type: 'checkpointReady' });
    if (generationStarted) ctx.events.onGenerationFinished?.(model.name);
    ctx.lifecycle.settle(convId);
  }
}
