import type { AgentKind, AgentLink } from './chatAgentLinks';

export type AskAgentOrigin = { kind: 'owner'; channel: 'telegram' };

/**
 * The live half of a linked-agent ask: the transport contract, the wait for a
 * session Forge did not start to become reachable, and delivery through it.
 *
 * Kept apart from `askAgentService.ts` (the ask lifecycle and its policies)
 * because two other modules — the agent-to-agent relay and the inbound reply
 * lifecycle — need delivery through a live session without wanting the ask
 * policy, and because "can this session be reached live?" has its own failure
 * modes: for Codex the thread list is read by spawning a throwaway app-server,
 * and that process not answering in time is an error, not a "no"
 * (`codexThreadIsLive`). Reading that as "the session is gone" is what made a
 * laptop's Forge-started Codex link answer once and then fail the same way
 * every time (laptop audit F10, 2026-10-26).
 *
 * `askAgentService.ts` re-exports all of this, so its consumers keep importing
 * one module; this file is the implementation and the single owner.
 */

/** What one linked-agent turn did, reported by whichever transport ran it. */
export interface AskAgentRunResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  finalText: string;
  error?: string;
  sessionGone?: boolean;
  /** The session still exists but another process holds it as its writer
   *  (Codex: "thread-store conflict … already has an active writer"), so it
   *  cannot be resumed; not set for a gone session or any other failure. */
  sessionLocked?: boolean;
  mayStillBeWorking?: boolean;
}

/**
 * The two transports an ask can run on: the session the owner opened (live) and
 * a session Forge starts itself (headless). `openPanel` only reports that a
 * panel link was handed to VS Code — for a `vscode://` link nothing can verify
 * that the panel then came up, which is why `waitForLive` exists.
 */
export interface AskAgentRuntime {
  openPanel(agent: AgentKind, sessionId: string): Promise<'opened' | 'unavailable'>;
  isLive(agent: AgentKind, link: AgentLink): Promise<boolean>;
  /**
   * Has this machine ever run this session? A link can carry a session id that
   * exists only on another machine — a chat opened by `forge.sh say --new` from
   * a desktop Claude session over WinRM — and then `isLive` is false forever:
   * no panel to open and no transcript to resume here. Answering false lets the
   * ask skip both the panel and the headless resume and unlink at once.
   * Optional: a runtime that does not answer it is treated as present, so an
   * existing test runtime keeps today's behaviour.
   */
  hasLocalTranscript?(agent: AgentKind, link: AgentLink): boolean;
  sendLive(
    agent: AgentKind,
    link: AgentLink,
    prompt: string,
    signal: AbortSignal,
    purpose?: 'ask' | 'reply',
    onAccepted?: () => void,
    origin?: AskAgentOrigin,
  ): Promise<AskAgentRunResult>;
  runHeadless(options: {
    agent: AgentKind;
    link: AgentLink;
    prompt: string;
    createSessionId?: string;
    /** Start a session the CLI names itself: no id is passed to the driver at
     *  all, so nothing is resumed. Used for a Codex first ask, where the link
     *  is only Forge's placeholder and its "id" is not a thread Codex can find. */
    startNew?: boolean;
    /** Validated, task-scoped Codex selection; never persisted as a default. */
    model?: string;
    effort?: string;
    sessionTitle: string;
    signal: AbortSignal;
    onAccepted?: () => void;
    onSessionId(sessionId: string): void;
  }): Promise<AskAgentRunResult>;
}

const LIVE_POLL_MS = 500;

/**
 * Wait for a session Forge did not start to become live: `true` when it did,
 * `false` when the wait ran out, and `'unknown'` when a check failed outright.
 * `'unknown'` is not a `no` — a Codex thread list read by a throwaway
 * app-server that never answers is an error, not a thread that is gone — so
 * the caller resumes headlessly at once instead of sitting out the rest of the
 * wait, and the headless resume reports `sessionGone` only if the CLI itself
 * says the thread is gone.
 */
export async function waitForLive(
  runtime: AskAgentRuntime,
  agent: AgentKind,
  linked: AgentLink,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean | 'unknown'> {
  const deadline = Date.now() + timeoutMs;
  do {
    signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const live = await Promise.race([
      runtime.isLive(agent, linked).catch(() => 'unknown' as const),
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
    if (live === 'unknown') return 'unknown';
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

/** Deliver an inbound answer through the same live transport used by ask_agent. */
export async function deliverAgentReply(
  runtime: AskAgentRuntime,
  agent: AgentKind,
  link: AgentLink,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  // A liveness check that fails outright is "cannot deliver live", not "the
  // delivery failed": the caller keeps the answer as a readable verdict rather
  // than reporting a failure it did not cause. Only Codex can fail this way —
  // its thread list is read by spawning a throwaway app-server, and that
  // process not answering in time is an error (`codexThreadIsLive`).
  let live: boolean;
  try {
    live = await runtime.isLive(agent, link);
  } catch {
    return false;
  }
  if (!live) return false;
  const result = await runtime.sendLive(agent, link, text, signal, 'reply');
  if (result.status !== 'completed')
    throw new Error(result.error ?? `Live ${agent} session did not accept Forge's reply.`);
  return true;
}
