import type { CodexAppServerSession } from '../agents/CodexAppServerSession';
import type { ClaudeSession } from '../agentBus/claudePeer';
import type { MeshAdapter, MeshSendOptions, TurnResult } from './meshAdapter';

/**
 * The agent-mesh delivery adapters (AGENT_MESH_PLAN §1, §2).
 *
 * - {@link CodexOwnedAdapter} wraps the warm owned `CodexAppServerSession`
 *   (observing: Forge sees the turn start and end directly → real
 *   `started`/`completed` states).
 * - {@link ClaudePeerAdapter} writes to a user-opened Claude session's peer
 *   pipe (non-observing: the exchange honestly stays `accepted`).
 * - {@link CodexQueueAdapter} hands a message to a user-opened Codex session
 *   with `codex queue` (non-observing: stays `accepted` until a verdict).
 */

/** Observing: the owned Codex app-server session. */
export class CodexOwnedAdapter implements MeshAdapter {
  readonly kind = 'codex' as const;
  readonly observesTurns = true;

  constructor(private readonly session: CodexAppServerSession) {}

  async send(message: string, options?: MeshSendOptions): Promise<TurnResult> {
    const result = await this.session.send(
      message,
      options?.signal ? { signal: options.signal } : {},
    );
    return {
      status: result.status === 'timed_out' ? 'failed' : result.status,
      finalText: result.finalText,
    };
  }
}

/** Non-observing: a user-opened Claude session reached through its peer pipe. */
export class ClaudePeerAdapter implements MeshAdapter {
  readonly kind = 'claude' as const;
  readonly observesTurns = false;

  constructor(
    private readonly session: ClaudeSession,
    private readonly sendClaude: (
      session: ClaudeSession,
      message: string,
      signal?: AbortSignal,
    ) => Promise<void>,
  ) {}

  async send(message: string, options?: MeshSendOptions): Promise<TurnResult> {
    await this.sendClaude(this.session, message, options?.signal);
    // The transport accepted it; with observesTurns=false the FIFO writes no
    // started/completed, so the exchange stays `accepted` (truthful).
    return { status: 'completed' };
  }
}

/** Non-observing: a user-opened Codex session reached with `codex queue`. */
export class CodexQueueAdapter implements MeshAdapter {
  readonly kind = 'codex' as const;
  readonly observesTurns = false;

  constructor(
    private readonly cli: string,
    private readonly thread: string,
    private readonly queueCodex: (
      cli: string,
      thread: string,
      message: string,
      signal?: AbortSignal,
    ) => Promise<void>,
  ) {}

  async send(message: string, options?: MeshSendOptions): Promise<TurnResult> {
    await this.queueCodex(this.cli, this.thread, message, options?.signal);
    return { status: 'completed' };
  }
}
