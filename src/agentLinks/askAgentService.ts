import { randomUUID } from 'crypto';
import type { ForgeConfig } from '../config/types';
import type { AgentLinksConfig } from '../config/agentBusSchema';
import type { CheckpointSession } from '../checkpoint/CheckpointStack';
import { snapshotWorkspaceBefore } from '../agents/WorkspaceCheckpoint';
import { DEFAULT_MAX_CLI_AGENTS } from '../agents/CliSessionRegistry';
import { unattendedCliRefusal } from '../jobs/cliAgentGate';
import { MAX_QUESTION_CHARS, questionSizeRefusal } from '../agentBus/liveSessionLimit';
import {
  agentDisplayName,
  get,
  link,
  touch,
  unlink,
  type AgentKind,
  type AgentLink,
} from './chatAgentLinks';
import type { AskAgentResult } from './askAgentResult';
export { renderAskAgentResult } from './askAgentResult';
export type { AskAgentResult } from './askAgentResult';
import { waitForLive, type AskAgentRunResult, type AskAgentRuntime } from './liveSessionDelivery';
// The transport contract and the live-delivery helper belong to
// `liveSessionDelivery.ts`, which the relay and the inbound reply lifecycle
// also use. They are re-exported here so the ask lifecycle keeps one import
// point for its consumers; that module is their owner and implementation.
export { deliverAgentReply } from './liveSessionDelivery';
export type { AskAgentRunResult, AskAgentRuntime } from './liveSessionDelivery';
import type { ConversationRuntime } from '../sidebar/sessionTypes';

export interface AskAgentContext {
  conversation: ConversationRuntime;
  checkpoint: CheckpointSession;
  signal: AbortSignal;
  workspaceRoot: string;
  persistConversation(): void;
  onSessionLinked?(link: AgentLink): void;
  onAccepted?(link: AgentLink): void;
  /** Validation passed and the ask now counts as running; nothing refused it. */
  onStarted?(): void;
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

const MAX_SUBJECT_CHARS = 160;
let activeAsks = 0;
const activeConversations = new Map<string, number>();

export function isAskAgentRunning(conversationId: string): boolean {
  return (activeConversations.get(conversationId) ?? 0) > 0;
}

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

function structuredResult(
  agent: AgentKind,
  subject: string,
  sessionTitle: string,
  result: AskAgentRunResult,
  live: boolean,
  notice?: string,
): AskAgentResult {
  return {
    agent,
    subject,
    sessionTitle,
    status: result.status,
    finalText: result.finalText,
    live,
    ...(result.error ? { error: result.error } : {}),
    ...(result.mayStillBeWorking ? { mayStillBeWorking: true } : {}),
    ...(notice ? { notice } : {}),
  };
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
  const createSessionId = options.createSessionId ?? randomUUID;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CLI_AGENTS;

  return async (raw: AskAgentRequest, context: AskAgentContext): Promise<AskAgentResult> => {
    const request = validateRequest(raw);
    if (activeAsks >= maxConcurrent)
      return structuredResult(
        request.agent,
        '',
        '',
        {
          status: 'failed',
          finalText: '',
          error: `Forge CLI agent capacity (${maxConcurrent}) is full; no session was contacted.`,
        },
        false,
      );
    const config = options.getConfig();
    if (config.agent_bus?.enabled !== true)
      return structuredResult(
        request.agent,
        '',
        '',
        {
          status: 'failed',
          finalText: '',
          error: 'ask_agent is disabled. Set `agent_bus.enabled: true` in config.yaml.',
        },
        false,
      );
    const refusal = unattendedCliRefusal(config, context.conversation.id);
    if (refusal)
      return structuredResult(
        request.agent,
        '',
        '',
        { status: 'failed', finalText: '', error: refusal },
        false,
      );
    const workspaceRoot = get(context.conversation, request.agent)?.cwd ?? context.workspaceRoot;
    if (!workspaceRoot)
      return structuredResult(
        request.agent,
        '',
        '',
        {
          status: 'failed',
          finalText: '',
          error: 'ask_agent requires an open workspace folder.',
        },
        false,
      );
    activeAsks += 1;
    activeConversations.set(
      context.conversation.id,
      (activeConversations.get(context.conversation.id) ?? 0) + 1,
    );
    context.onStarted?.();
    let capture: Awaited<ReturnType<typeof snapshotWorkspaceBefore>> | undefined;
    try {
      if (request.agent === 'copilot')
        capture = await snapshotWorkspaceBefore(context.checkpoint, workspaceRoot, context.signal);
      return await ask(request, context, options, createSessionId);
    } catch (error) {
      return structuredResult(
        request.agent,
        '',
        '',
        {
          status: 'failed',
          finalText: '',
          error: error instanceof Error ? error.message : String(error),
        },
        false,
      );
    } finally {
      try {
        await capture?.finish();
      } finally {
        activeAsks -= 1;
        const remaining = (activeConversations.get(context.conversation.id) ?? 1) - 1;
        if (remaining > 0) activeConversations.set(context.conversation.id, remaining);
        else activeConversations.delete(context.conversation.id);
      }
    }
  };
}

/** What the owner can do when a resumed session also fails: the link is kept,
 *  so the same ask would fail the same way until the row is removed. */
const RESUME_FAILED_HINT =
  ' If it keeps failing, unlink this session in the chat header and ask again to start a fresh one.';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ask(
  request: AskAgentRequest,
  context: AskAgentContext,
  options: AskAgentServiceOptions,
  createSessionId: () => string,
): Promise<AskAgentResult> {
  const agent = request.agent;
  const label = agentDisplayName(agent);
  const title = description(request, context.conversation.title);
  let linked = get(context.conversation, agent);
  // One writer per Codex thread. A `forge-created` Codex link is an `exec`
  // thread, which the VS Code Codex panel never lists (its `thread/list` read
  // defaults to interactive sources), so the panel cannot show it — and opening
  // the panel on it takes the thread's writer lock, the very lock the headless
  // resume then fails to take. So Forge resumes a Codex thread it started itself
  // headlessly and never opens a panel on one. `user-set` and `first-inbound`
  // links are panel-owned threads and keep today's panel behaviour.
  const panel =
    options.getLinkConfig().open_panel === 'every_ask' &&
    agent !== 'copilot' &&
    !(agent === 'codex' && linked?.origin === 'forge-created');
  let sessionCwd = linked?.cwd ?? context.workspaceRoot;
  let lead = '';
  let accepted = false;
  const markAccepted = (target: AgentLink): void => {
    if (accepted) return;
    accepted = true;
    context.onAccepted?.(target);
  };

  if (linked) {
    linked = touch(context.conversation, agent);
    context.persistConversation();
    context.onSessionLinked?.(linked);
    // A liveness check can fail outright instead of answering: reading a Codex
    // thread list means spawning a throwaway app-server, and that process not
    // answering in time is an error, not a "no" (`codexThreadIsLive`). Read as
    // "the session is gone", that used to hard-fail the ask with a discovery
    // message nobody could act on. Here it means "cannot be verified"; an
    // `every_ask` policy still tries the panel, then resumes headlessly if that
    // bounded check cannot confirm the session. The resume reports `sessionGone`
    // only when the CLI itself says the thread is gone.
    let live: boolean;
    try {
      live = await options.runtime.isLive(agent, linked);
    } catch (error) {
      live = false;
      lead = `${label} session could not be checked (${errorMessage(error)}); resumed headlessly. `;
    }
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
        'ask',
        () => markAccepted(linked!),
      );
    } else if (panel) {
      const opened = await options.runtime.openPanel(agent, linked.sessionId);
      if (opened === 'opened') {
        // Opening a `vscode://` link is not a promise anyone can keep: the
        // opener reports `'opened'` whatever the panel then does, so the only
        // honest reading of a thread that never appears in the list is "it did
        // not come up". That used to be a dead end — the ask failed, the link
        // stayed `linked`, and every later send failed the same way. Now it
        // resumes the same session headlessly, exactly like the `'unavailable'`
        // case beside it, and a `sessionGone` from that resume takes the
        // existing unlink-and-start-a-new-session path.
        const cameUp = await waitForLive(
          options.runtime,
          agent,
          linked,
          options.getLinkConfig().panel_live_timeout_ms,
          context.signal,
        );
        if (cameUp === true) {
          lead = '';
          liveResult = await options.runtime.sendLive(
            agent,
            linked,
            promptFor(request, linked, false),
            context.signal,
            'ask',
            () => markAccepted(linked!),
          );
        } else if (cameUp === 'unknown') {
          lead = `${label} session could not be checked; resumed headlessly. `;
        } else {
          lead = `${label} panel did not come up for session "${linked.title}"; resumed headlessly. `;
        }
      } else {
        lead = `${label} panel could not be opened; resumed headlessly. `;
      }
    }

    if (liveResult && !liveResult.sessionGone)
      return structuredResult(agent, title, linked.title, liveResult, true, lead || undefined);
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
        onAccepted: () => markAccepted(linked!),
        onSessionId: (sessionId) => {
          if (sessionId !== linked?.sessionId)
            throw new Error(
              `${label} resume returned a different session id; no link was changed.`,
            );
        },
      });
      if (!resumed.sessionGone && !resumed.sessionLocked)
        return structuredResult(
          agent,
          title,
          linked.title,
          resumed,
          false,
          resumed.status === 'completed'
            ? lead || undefined
            : lead
              ? `${lead.trimEnd()}${RESUME_FAILED_HINT}`
              : undefined,
        );
      // A thread another process still holds as its writer cannot be resumed,
      // and keeping the link would make every later ask fail the same way. It is
      // not gone, so the notice says where it is instead: usually a Codex panel
      // or another Codex window holding it open, not a run still working.
      const goneTitle = linked.title;
      sessionCwd = linked.cwd;
      unlink(context.conversation, agent);
      context.persistConversation();
      lead += resumed.sessionLocked
        ? `${label} session "${goneTitle}" is open in another Codex window (for example the VS Code Codex panel) and could not be resumed; unlinked it and started a new one. `
        : `${label} session "${goneTitle}" no longer exists; started a new one. `;
    }
  }

  const now = Date.now();
  const sessionId = agent === 'codex' ? undefined : createSessionId();
  const initial = sessionId
    ? createLink(agent, sessionId, sessionCwd, `Forge · ${context.conversation.title}`, now)
    : undefined;
  if (initial) {
    linked = link(context.conversation, initial);
    context.persistConversation();
    context.onSessionLinked?.(linked);
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
    // Codex names its own thread, so there is no id to hand it here; `startNew`
    // says that explicitly so the runtime gives the driver nothing to resume.
    // The placeholder link is Forge's bookkeeping, not a thread Codex can find.
    ...(sessionId ? { createSessionId: sessionId } : { startNew: true }),
    sessionTitle: placeholder.title,
    signal: context.signal,
    onAccepted: () => markAccepted(linked ?? placeholder),
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
        );
        acceptedId = saved.sessionId;
        linked = saved;
        context.persistConversation();
        context.onSessionLinked?.(saved);
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
    return structuredResult(
      agent,
      title,
      placeholder.title,
      {
        status: 'failed',
        finalText: '',
        error: `${label} returned without reporting a session id; its reply was not accepted.`,
      },
      false,
    );
  if (firstCodexAsk && acceptedId) {
    const startedLine = `Codex: started a new background thread <${acceptedId}> (not your open Codex panel chat); use /link in this chat to link a panel chat instead.`;
    lead = [startedLine, lead.trim()].filter(Boolean).join('\n');
    lead += '\n';
  }
  return structuredResult(
    agent,
    title,
    linked?.title ?? placeholder.title,
    result,
    false,
    lead || undefined,
  );
}
