/**
 * The delivery state machine (AGENT_MESH_PLAN §2). Replaces v1's single
 * "delivered", which recorded a fire-and-forget `codex queue` exit 0 as if the
 * message had been processed.
 *
 *   created → accepted → observed → started → completed
 *                ↘ rejected      ↘ timeout / stalled / cancelled / unknown
 *
 * A transport exit code may advance a state **only** to `accepted`. `started`
 * and `completed` are reported by an owned session that observes the turn
 * directly; a user-opened session honestly stays at `accepted` (or `observed`)
 * until a verdict appears.
 *
 * This module is pure: it knows the states and the legal transitions, and how
 * to derive the latest state of an exchange from its event stream. It does not
 * touch the filesystem — the exchange log (exchangeLog.ts) is the writer.
 */

export type ExchangeState =
  | 'created'
  | 'accepted'
  | 'observed'
  | 'started'
  | 'completed'
  | 'rejected'
  | 'timeout'
  | 'stalled'
  | 'cancelled'
  | 'unknown'
  | 'crashed'
  | 'recovered'
  | 'context_lost';

/**
 * Terminal states (M8): the set the compaction policy is allowed to remove
 * whole exchanges of. `unknown` and `stalled` are deliberately NOT terminal —
 * a receipt can still resolve `unknown`, and a stalled turn can still finish —
 * so they stay exempt from compaction until they reach a true terminal state
 * (or a deadline turns them into `timeout`).
 */
export const TERMINAL_STATES: ReadonlySet<ExchangeState> = new Set<ExchangeState>([
  'completed',
  'rejected',
  'timeout',
  'cancelled',
  'crashed',
  'recovered',
  'context_lost',
]);

export function isTerminal(state: ExchangeState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * The legal transitions. Anything not listed here is a protocol error and must
 * be rejected (the log will not record a transition it cannot prove). The
 * `started → completed` edge is the one an owned session reports for free;
 * `accepted → started` is the normal path (a queued message begins its turn).
 */
const TRANSITIONS: Readonly<Record<ExchangeState, readonly ExchangeState[]>> = {
  created: ['accepted', 'rejected', 'timeout'],
  accepted: ['observed', 'started', 'rejected', 'timeout', 'cancelled', 'unknown'],
  observed: ['started', 'timeout', 'cancelled', 'unknown'],
  started: ['completed', 'stalled', 'cancelled', 'crashed', 'timeout', 'unknown'],
  stalled: ['completed', 'timeout', 'crashed', 'cancelled'],
  unknown: ['completed', 'timeout', 'crashed', 'cancelled'],
  crashed: ['recovered', 'context_lost'],
  completed: [],
  rejected: [],
  timeout: [],
  cancelled: [],
  recovered: [],
  context_lost: [],
};

/** Is `to` a legal next state after `from`? */
export function canTransition(from: ExchangeState, to: ExchangeState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Derive the latest state of one exchange from its (ordered) events, skipping
 * duplicate event ids. Returns undefined when the exchange has no events.
 *
 * The log is append-only and never rewritten, so "latest state" is always
 * derived by reading — this is the single place that rule is implemented.
 *
 * F-03: once an exchange reaches a TERMINAL state, it stays there. A late
 * event after a terminal (a verdict that arrives after the non-terminal
 * deadline wrote `timeout`, a duplicate completion) is an ORPHAN, not a new
 * completion — deriving "last event wins" would let a late `completed` flip a
 * `timeout` back to success. So derivation stops at the first terminal state.
 */
export function deriveLatestState(
  events: ReadonlyArray<{ state: ExchangeState; eventId: string }>,
): ExchangeState | undefined {
  const seen = new Set<string>();
  let latest: ExchangeState | undefined;
  for (const e of events) {
    if (seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    latest = e.state;
    if (isTerminal(e.state)) return e.state;
  }
  return latest;
}

/** The states that render as "queued" in the board UI — never "delivered". */
export function rendersAsQueued(state: ExchangeState): boolean {
  return state === 'created' || state === 'accepted' || state === 'observed';
}
