import { readEvents, groupByExchange, latestStates } from './exchangeLog';
import { rendersAsQueued, type ExchangeState } from './deliveryState';
import { listOwnedAliases, readOwnership } from './ownership';
import { listAliases } from './aliasRegistry';
import type { HostLivenessDeps } from './hostIdentity';

/**
 * The agent board's read projection (AGENT_MESH_PLAN §3, P2 — render only).
 *
 * The writer (exchange log) shipped in P0; this module only READS it and
 * derives what the user sees: the latest state per exchange (scoped to a
 * workspace + conversation) and the live-session states. It is pure — no
 * writes, no posting — so the Telegram `/status` board line and the sidebar
 * "Agent board" section both call it and cannot disagree about what happened.
 *
 * M9 scoping: an event with no conversation is sidebar-only, never Telegram.
 * So the Telegram projection filters by conversation; the sidebar projection
 * (conversation undefined) shows the workspace's whole board.
 */

export interface BoardRow {
  exchangeId: string;
  from: string;
  to?: string;
  /** The latest (derived) state of the exchange. */
  state: ExchangeState;
  /** The ts of the exchange's latest event (newest-first ordering). */
  lastTs: number;
  /** How the state renders: "queued" for non-terminal pre-start states. */
  label: string;
  detail?: string;
}

export interface LiveSession {
  alias: string;
  agent: 'claude' | 'codex';
  /** live (owned, running or idle), parked, dead, or none (no owned session). */
  state: 'live' | 'parked' | 'dead' | 'none';
}

export interface BoardView {
  board: BoardRow[];
  liveSessions: LiveSession[];
}

/** How a state renders as a short label (the board never says "delivered"). */
export function stateLabel(state: ExchangeState): string {
  if (rendersAsQueued(state)) return 'queued';
  return state;
}

/**
 * The board for one scope: the last `limit` exchanges (newest first), latest
 * state per exchange. `conversation` undefined ⇒ the whole workspace (the
 * sidebar); a conversation id ⇒ only that conversation's exchanges (Telegram).
 */
export function projectBoard(
  logPath: string,
  workspace: string,
  conversation: string | undefined,
  limit = 5,
): BoardRow[] {
  const events = readEvents(logPath).filter(
    (e) =>
      e.workspace === workspace && (conversation === undefined || e.conversation === conversation),
  );
  const groups = groupByExchange(events);
  const states = latestStates(events);
  const rows: BoardRow[] = [];
  for (const [exchangeId, evs] of groups) {
    const state = states.get(exchangeId);
    if (state === undefined) continue;
    const last = evs[evs.length - 1];
    rows.push({
      exchangeId,
      from: last.from,
      ...(last.to ? { to: last.to } : {}),
      state,
      lastTs: Math.max(...evs.map((e) => e.ts)),
      label: stateLabel(state),
      ...(last.detail ? { detail: last.detail } : {}),
    });
  }
  rows.sort((a, b) => b.lastTs - a.lastTs);
  return rows.slice(0, limit);
}

/**
 * The live-session states for the "Live sessions" line. Every known alias
 * (registered + the ones with an ownership record) is listed with its state:
 * `live` (owned, not parked), `parked` (owned, parked), `dead` (owned, owner
 * host proven dead), `none` (no owned session — a user-opened pin or alias
 * with no record).
 */
export function projectLiveSessions(root: string, deps: HostLivenessDeps = {}): LiveSession[] {
  const aliases = listAliases(root);
  const owned = listOwnedAliases(root);
  const set = new Set<string>([...Object.keys(aliases), ...owned]);
  const out: LiveSession[] = [];
  for (const alias of [...set].sort()) {
    const rec = readOwnership(root, alias);
    const aliasRec = aliases[alias];
    const agent = rec?.agent ?? aliasRec?.agent ?? 'codex';
    if (!rec) {
      out.push({ alias, agent, state: 'none' });
      continue;
    }
    if (rec.owner_host === null) {
      out.push({ alias, agent, state: 'dead' });
      continue;
    }
    // owner_host present: is that host still the one that wrote it? (default:
    // treat as alive — an unprovable death is not a dead session.)
    const alive = (deps.isHostAlive ?? (() => true))(rec.owner_host);
    out.push({ alias, agent, state: rec.parked ? 'parked' : alive ? 'live' : 'dead' });
  }
  return out;
}

/** The full board view for one scope. */
export function projectBoardView(
  logPath: string,
  workspace: string,
  conversation: string | undefined,
  root: string,
  deps: HostLivenessDeps = {},
  limit = 5,
): BoardView {
  return {
    board: projectBoard(logPath, workspace, conversation, limit),
    liveSessions: projectLiveSessions(root, deps),
  };
}
