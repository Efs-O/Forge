import { randomUUID } from 'crypto';
import type { ForgeConfig } from '../config/types';
import type { AgentLinksConfig } from '../config/agentBusSchema';
import type { CheckpointSession } from '../checkpoint/CheckpointStack';
import { snapshotWorkspaceBefore } from '../agents/WorkspaceCheckpoint';
import { DEFAULT_MAX_CLI_AGENTS } from '../agents/CliSessionRegistry';
import { unattendedCliRefusal } from '../jobs/cliAgentGate';
import { MAX_QUESTION_CHARS, questionSizeRefusal } from '../agentBus/liveSessionLimit';
import { get, link, touch, unlink, type AgentKind, type AgentLink } from './chatAgentLinks';
import type { ConversationRuntime } from '../sidebar/sessionTypes';

export interface AskAgentRunResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  finalText: string;
  error?: string;
  sessionGone?: boolean;
  mayStillBeWorking?: boolean;
}

export interface AskAgentRuntime {
  openPanel(agent: AgentKind, sessionId: string): Promise<'opened' | 'unavailable'>;
  isLive(agent: AgentKind, link: AgentLink): Promise<boolean>;
  sendLive(
    agent: AgentKind,
    link: AgentLink,
    prompt: string,
    signal: AbortSignal,
    purpose?: 'ask' | 'reply',
  ): Promise<AskAgentRunResult>;
  runHeadless(options: {
    agent: AgentKind;
    link: AgentLink;
    prompt: string;
    createSessionId?: string;
    sessionTitle: string;
    signal: AbortSignal;
    onSessionId(sessionId: string): void;
  }): Promise<AskAgentRunResult>;
}

/** Deliver an inbound answer through the same live transport used by ask_agent. */
export async function deliverAgentReply(
  runtime: AskAgentRuntime,
  agent: AgentKind,
  link: AgentLink,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!(await runtime.isLive(agent, link))) return false;
  const result = await runtime.sendLive(agent, link, text, signal, 'reply');
  if (result.status !== 'completed')
    throw new Error(result.error ?? `Live ${agent} session did not accept Forge's reply.`);
  return true;
}

export interface AskAgentContext {
  conversation: ConversationRuntime;
  checkpoint: CheckpointSession;
  signal: AbortSignal;
  workspaceRoot: string;
  persistConversation(): void;
}

export interface AskAgentRequest {
  agent: AgentKind;
  message: string;
  subject?: string;
}

export interface AskAgentServiceOptions {
  getConfig: () => ForgeConfig;
  runtime: AskAgentRuntime;
  getLinkConfig: () => AgentLinksConfig;
  createSessionId?: () => string;
  maxConcurrent?: number;
}

const LIVE_POLL_MS = 500;
const MAX_SUBJECT_CHARS = 160;

function description(request: AskAgentRequest, title: string): string {
  const heading = request.subject?.trim() || request.message.trim().split(/\r?\n/u, 1)[0] || title;
  return heading.length > MAX_SUBJECT_CHARS ? `${heading.slice(0, MAX_SUBJECT_CHARS)}…` : heading;
}

function promptFor(request: AskAgentRequest, link: AgentLink, firstCodexAsk: boolean): string {
  const task = request.message.trim();
  const subject = request.subject?.trim();
  const body = subject ? `Subject: ${subject}\n\n${task}` : task;
  const titleLine = firstCodexAsk ? `${link.title}\n\n` : '';
  return `${titleLine}[Forge ask]\n\n${body}\n\nReturn a concise answer for the Forge chat.`;
}

function agentLabel(agent: AgentKind): string {
  return agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Copilot';
}

function validateRequest(value: AskAgentRequest): AskAgentRequest {
  if (!value.message.trim()) throw new Error('ask_agent: "message" is required.');
  if (value.message.length > MAX_QUESTION_CHARS)
    throw new Error(questionSizeRefusal(`"message" exceeds ${MAX_QUESTION_CHARS} characters.`));
  if (value.subject !== undefined && !value.subject.trim())
    throw new Error('ask_agent: "subject" must not be empty.');
  if (value.subject && (value.subject.length > MAX_SUBJECT_CHARS || /[\r\n]/u.test(value.subject)))
    throw new Error(
      `ask_agent: "subject" must be one line of at most ${MAX_SUBJECT_CHARS} characters.`,
    );
  return value;
}

async function waitForLive(
  runtime: AskAgentRuntime,
  agent: AgentKind,
  linked: AgentLink,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const live = await Promise.race([
      runtime.isLive(agent, linked),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      }),
      new Promise<boolean>((resolve) => {
        onAbort = () => resolve(false);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    });
    signal.throwIfAborted();
    if (live) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.min(LIVE_POLL_MS, remaining));
      signal.addEventListener('abort', finish, { once: true });
    });
  } while (!signal.aborted);
  return false;
}

function resultText(
  label: string,
  subject: string,
  result: AskAgentRunResult,
  live: boolean,
): string {
  if (result.status === 'cancelled') {
    if (live && result.mayStillBeWorking)
      return `Forge stopped waiting for ${label}; its session may still be working. The ask was not resumed elsewhere.`;
    return `Stopped the ${label} ask before it returned a reply.`;
  }
  if (result.status !== 'completed')
    return `Error: ${label} could not answer: ${result.error ?? (result.finalText || 'unknown failure')}`;
  const note = live
    ? '\n\nEdits this live session makes after its reply are outside this ask’s checkpoint.'
    : '';
  return `**Asked ${label}:** ${subject}\n\n**${label} says:**\n\n${result.finalText.trim()}${note}`;
}

function createLink(
  agent: AgentKind,
  sessionId: string,
  cwd: string,
  title: string,
  now: number,
): AgentLink {
  return {
    kind: agent,
    sessionId,
    cwd,
    title,
    linkedAt: now,
    lastUsedAt: now,
    origin: 'forge-created',
  };
}

export function makeAskAgentHandler(options: AskAgentServiceOptions) {
  let active = 0;
  const createSessionId = options.createSessionId ?? randomUUID;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CLI_AGENTS;

  return async (raw: AskAgentRequest, context: AskAgentContext): Promise<string> => {
    const request = validateRequest(raw);
    if (active >= maxConcurrent)
      return `Error: Forge CLI agent capacity (${maxConcurrent}) is full; no session was contacted.`;
    const config = options.getConfig();
    if (config.agent_bus?.enabled !== true)
      return 'Error: ask_agent is disabled. Set `agent_bus.enabled: true` in config.yaml.';
    const refusal = unattendedCliRefusal(config, context.conversation.id);
    if (refusal) return `Error: ${refusal}`;
    const workspaceRoot = get(context.conversation, request.agent)?.cwd ?? context.workspaceRoot;
    if (!workspaceRoot)
      return 'Error: ask_agent requires an open workspace folder for its checkpoint.';
    active += 1;
    let capture: Awaited<ReturnType<typeof snapshotWorkspaceBefore>> | undefined;
    try {
      capture = await snapshotWorkspaceBefore(context.checkpoint, workspaceRoot, context.signal);
      return await ask(request, context, options, createSessionId);
    } finally {
      try {
        await capture?.finish();
      } finally {
        active -= 1;
      }
    }
  };
}

async function ask(
  request: AskAgentRequest,
  context: AskAgentContext,
  options: AskAgentServiceOptions,
  createSessionId: () => string,
): Promise<string> {
  const agent = request.agent;
  const label = agentLabel(agent);
  const title = description(request, context.conversation.title);
  const panel = options.getLinkConfig().open_panel === 'every_ask' && agent !== 'copilot';
  let linked = get(context.conversation, agent);
  let sessionCwd = linked?.cwd ?? context.workspaceRoot;
  let lead = '';

  if (linked) {
    linked = touch(context.conversation, agent);
    context.persistConversation();
    const live = await options.runtime.isLive(agent, linked);
    let liveResult: AskAgentRunResult | undefined;
    if (live) {
      if (panel) {
        const opened = await options.runtime.openPanel(agent, linked.sessionId);
        if (opened === 'unavailable')
          lead = `${label} panel could not be opened; using its live session. `;
      }
      liveResult = await options.runtime.sendLive(
        agent,
        linked,
        promptFor(request, linked, false),
        context.signal,
      );
    } else if (panel) {
      const opened = await options.runtime.openPanel(agent, linked.sessionId);
      if (opened === 'opened') {
        if (
          !(await waitForLive(
            options.runtime,
            agent,
            linked,
            options.getLinkConfig().panel_live_timeout_ms,
            context.signal,
          ))
        ) {
          return `Error: the ${label} panel did not come up for session "${linked.title}"; the ask was not sent.`;
        }
        liveResult = await options.runtime.sendLive(
          agent,
          linked,
          promptFor(request, linked, false),
          context.signal,
        );
      } else {
        lead = `${label} panel could not be opened; resumed headlessly. `;
      }
    }

    if (liveResult && !liveResult.sessionGone)
      return lead + resultText(label, title, liveResult, true);
    if (liveResult?.sessionGone) {
      const goneTitle = linked.title;
      sessionCwd = linked.cwd;
      unlink(context.conversation, agent);
      context.persistConversation();
      linked = undefined;
      lead += `${label} session "${goneTitle}" no longer exists; started a new one. `;
    }

    if (linked) {
      const resumed = await options.runtime.runHeadless({
        agent,
        link: linked,
        prompt: promptFor(request, linked, false),
        sessionTitle: linked.title,
        signal: context.signal,
        onSessionId: (sessionId) => {
          if (sessionId !== linked?.sessionId)
            throw new Error(
              `${label} resume returned a different session id; no link was changed.`,
            );
        },
      });
      if (!resumed.sessionGone) return lead + resultText(label, title, resumed, false);
      const goneTitle = linked.title;
      sessionCwd = linked.cwd;
      unlink(context.conversation, agent);
      context.persistConversation();
      lead += `${label} session "${goneTitle}" no longer exists; started a new one. `;
    }
  }

  const now = Date.now();
  const sessionId = agent === 'codex' ? undefined : createSessionId();
  const initial = sessionId
    ? createLink(agent, sessionId, sessionCwd, `Forge · ${context.conversation.title}`, now)
    : undefined;
  if (initial) {
    linked = link(context.conversation, initial, [context.conversation]);
    context.persistConversation();
  }
  const placeholder =
    initial ??
    createLink(
      agent,
      `pending-${agent}-session`,
      sessionCwd,
      `Forge · ${context.conversation.title}`,
      now,
    );
  let acceptedId = initial?.sessionId;
  let sessionConfirmed = false;
  const firstCodexAsk = agent === 'codex' && !initial;
  const prompt = promptFor(request, placeholder, firstCodexAsk);
  const result = await options.runtime.runHeadless({
    agent,
    link: placeholder,
    prompt,
    ...(sessionId ? { createSessionId: sessionId } : {}),
    sessionTitle: placeholder.title,
    signal: context.signal,
    onSessionId: (reportedId) => {
      if (initial) {
        if (reportedId !== initial.sessionId)
          throw new Error(`${label} created session ${reportedId}, expected ${initial.sessionId}.`);
        sessionConfirmed = true;
      }
      if (!initial) {
        if (!reportedId.trim()) throw new Error(`${label} reported an empty session id.`);
        const saved = link(
          context.conversation,
          createLink(agent, reportedId, sessionCwd, placeholder.title, now),
          [context.conversation],
        );
        acceptedId = saved.sessionId;
        linked = saved;
        context.persistConversation();
      }
    },
  });
  const firstRunFailedBeforeSession =
    initial !== undefined &&
    result.status !== 'completed' &&
    (agent === 'claude'
      ? !sessionConfirmed
      : agent === 'copilot' && result.finalText.trim().length === 0);
  if (firstRunFailedBeforeSession) {
    unlink(context.conversation, agent);
    context.persistConversation();
  }
  if (result.status === 'completed' && !acceptedId)
    return `Error: ${label} returned without reporting a session id; its reply was not accepted.`;
  const success = resultText(label, title, result, false);
  return lead + success;
}
