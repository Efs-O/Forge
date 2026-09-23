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
   * Which session this adapter reaches (e.g. `claude-peer:<pid>`). When a later
   * resolution yields a different key, an idle FIFO is rebuilt on the new one,
   * so a session that joined, died or was replaced is not written to forever.
   */
  readonly key?: string;
  /** Shown to the user with the result: set on a stand-in for a dead joined session. */
  note?: string;
  /**
   * Deliver a message. Observing: starts a turn, resolves at turn end.
   * Non-observing: resolves once the transport accepts it. The FIFO (the only
   * caller) owns the started/completed timing from `observesTurns`.
   */
  send(message: string, options?: MeshSendOptions): Promise<TurnResult>;
  /**
   * F-06: interrupt the active turn (a `priority=steer` message). The current
   * `send()` resolves with a cancelled status so the FIFO can proceed to the
   * steer. Absent for non-observing adapters (no turn to interrupt).
   */
  interrupt?(): void;
  /**
   * Called by the FIFO when its queue drains. A one-shot stand-in disposes
   * itself here, so its process never outlives the exchanges it answered.
   */
  onIdle?(): void;
}

/** A factory for an adapter bound to one alias's resolved session. */
export type MeshAdapterFactory = (alias: string, sessionId: string) => MeshAdapter | undefined;
