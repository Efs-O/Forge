import type { AgentKind } from './aliasRegistry';

/**
 * The agent-mesh delivery adapters (AGENT_MESH_PLAN §1, §2, M5).
 *
 * An adapter is the one way a message reaches one agent. Two shapes:
 *
 * - **observing (owned session):** Forge holds the handle, so it sees the turn
 *   begin and end directly. `send()` starts a turn and resolves at turn end;
 *   the `onStart` callback fires the moment the turn is dispatched. This is
 *   what makes real `started`/`completed` states possible (§2). The owned
 *   Codex session (CodexAppServerSession) and the P4 owned Claude session are
 *   this shape.
 * - **non-observing (user-opened session):** Forge can only hand the message to
 *   the transport (`codex queue` exit 0, a peer-pipe write). `send()` resolves
 *   once the transport **accepts** it; the exchange honestly stays at
 *   `accepted` (or `observed`) until a verdict appears. `observesTurns` is
 *   false, so the FIFO never writes `started` for it.
 *
 * The per-alias FIFO (aliasFifo.ts) is the only caller of `send()`, and it
 * never calls it while a turn is running (M5) — `CodexAppServerSession.send()`
 * throws otherwise.
 */

export interface TurnResult {
  status: 'completed' | 'failed' | 'cancelled';
  finalText?: string;
}

export interface MeshSendOptions {
  signal?: AbortSignal;
}

export interface MeshAdapter {
  kind: AgentKind;
  /** True when the adapter observes turn start/end (an owned session). */
  observesTurns: boolean;
  /**
   * Deliver a message. Observing: starts a turn, resolves at turn end.
   * Non-observing: resolves once the transport accepts it. The FIFO (the only
   * caller) owns the started/completed timing from `observesTurns`.
   */
  send(message: string, options?: MeshSendOptions): Promise<TurnResult>;
}

/** A factory for an adapter bound to one alias's resolved session. */
export type MeshAdapterFactory = (alias: string, sessionId: string) => MeshAdapter | undefined;
