/**
 * The Copilot ACP turn lifecycle, split out of `CopilotAcpSession`.
 *
 * A turn is the unit of exactly-once settlement: the public `send()` promise
 * resolves through {@link settleCopilotTurn} and no other path may settle it.
 * The turn tracks whether the `session/prompt` request ever went out
 * (`promptSent`) — a cancel before that point settles as cancelled without
 * sending a prompt or a meaningless `session/cancel` for a turn that never
 * started.
 */

import type { CliAgentRunResult } from './types';

export interface CopilotActiveTurn {
  /** Accumulated answer text (agent_message_chunk only). */
  text: string;
  /** Resolves the public `send()` promise. */
  resolve(result: CliAgentRunResult): void;
  /** The public `send()` promise itself. */
  promise: Promise<CliAgentRunResult>;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** An abort or `interrupt()` arrived. */
  interrupted: boolean;
  /** The per-turn deadline fired. */
  timedOut: boolean;
  /** The `session/prompt` request was written to the transport. */
  promptSent: boolean;
  /** A `session/cancel` notification was written to the transport. */
  cancelSent: boolean;
  timer?: ReturnType<typeof setTimeout>;
  onEvent?: (event: { kind: 'text' | 'status'; text: string }) => void;
  /** Set by {@link settleCopilotTurn}; later settlements are ignored. */
  settled: boolean;
}

export interface CopilotTurnOptions {
  signal?: AbortSignal;
  onEvent?: (event: { kind: 'text' | 'status'; text: string }) => void;
}

/** Creates an unsettled turn owning its public promise. */
export function createCopilotTurn(options: CopilotTurnOptions): CopilotActiveTurn {
  let resolveFn: (result: CliAgentRunResult) => void;
  const promise = new Promise<CliAgentRunResult>((resolve) => {
    resolveFn = resolve;
  });
  return {
    text: '',
    resolve: (result) => resolveFn(result),
    promise,
    interrupted: false,
    timedOut: false,
    promptSent: false,
    cancelSent: false,
    settled: false,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  };
}

/**
 * Settles the turn exactly once: the first call wins, later calls (a late
 * terminal response racing a stop) are ignored. Detaches the timer and abort
 * listener either way.
 */
export function settleCopilotTurn(turn: CopilotActiveTurn, result: CliAgentRunResult): void {
  if (turn.timer) clearTimeout(turn.timer);
  if (turn.signal && turn.onAbort) turn.signal.removeEventListener('abort', turn.onAbort);
  if (turn.settled) return;
  turn.settled = true;
  turn.resolve(result);
}

/** The terminal status a stop/cancel path settles the turn with. */
export function copilotTurnStatus(turn: CopilotActiveTurn): 'timed_out' | 'cancelled' | 'failed' {
  return turn.timedOut ? 'timed_out' : turn.interrupted ? 'cancelled' : 'failed';
}
