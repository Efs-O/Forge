import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getHostIdentity, type HostId, type HostLivenessDeps } from './hostIdentity';
import { acquireLock, releaseLock } from './lock';

/** Remove a tmp file, ignoring ENOENT (a compaction rewrite that failed mid-way). */
function unlinkQuietFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
import { canTransition, deriveLatestState, isTerminal, type ExchangeState } from './deliveryState';

/**
 * The exchange board's durable store (AGENT_MESH_PLAN §3, M1, M8).
 *
 * `exchanges.jsonl` is an append-only **event** log. It is never rewritten in
 * place; the latest state of an exchange is always *derived* by reading.
 * Compaction removes **whole terminal exchanges** (all their events leave
 * together) and never a lone transition or a non-terminal exchange.
 *
 * Multi-window (M1): every window is its own process and all share the bus
 * folder, so the log has several writers **across processes**. Every write —
 * append and compaction — takes one interprocess lock (`exchanges.lock`,
 * O_EXCL, holding the holder's `{pid, startedAt}`). Inside a window, writes
 * still serialize through an in-process queue. A lock is stale only when its
 * holder host is proven dead; age alone never makes it stale.
 */

export interface ExchangeEvent {
  /** Monotonic within the log; assigned at append. */
  seq: number;
  /** UUID. A duplicate event id is skipped on read (recovery replays safely). */
  eventId: string;
  ts: number;
  exchangeId: string;
  /** Workspace root the event belongs to (scope; the sidebar renders only its own). */
  workspace: string;
  /** Conversation id, when one is bound. Absent → sidebar-only, never Telegram (M9). */
  conversation?: string;
  /** Sender alias. */
  from: string;
  /** Recipient alias, when present. */
  to?: string;
  /** What kind of event: 'message' | 'state' | 'relay' | 'notice'. */
  type: string;
  state: ExchangeState;
  detail?: string;
}

export interface ExchangeLogPaths {
  log: string;
  lock: string;
}

export interface ExchangeLogDeps extends HostLivenessDeps {
  now?: () => number;
  /** Injectable for tests: the interprocess lock holder probe. */
  isHostAlive?: (recorded: HostId) => boolean;
  /** How long to wait for a contended lock before giving up. Default 5 s. */
  lockTimeoutMs?: number;
}

/** Last-N terminal exchanges kept by compaction (the plan's N=200). */
export const DEFAULT_MAX_EXCHANGES = 200;
/** 24 h backstop; only fires when fewer than N exchanges exist. */
export const DEFAULT_TTL_MS = 24 * 60 * 60_000;
/**
 * M8: a non-terminal exchange that has no new event within this window gets a
 * terminal `timeout` event (e.g. a user-opened session that stays `accepted`
 * with no verdict). After that it is eligible for compaction like any other.
 */
export const NON_TERMINAL_DEADLINE_MS = 24 * 60 * 60_000;

/** A durable artifact in the bus folder; the CI row lists it. */
export const EXCHANGES_LOG_NAME = 'exchanges.jsonl';
export const EXCHANGES_LOCK_NAME = 'exchanges.lock';

// ---------------------------------------------------------------------------
// Lock (M1)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// In-process queue (M1): one window never holds the lock twice at once.
// ---------------------------------------------------------------------------

let inProcessQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = inProcessQueue.then(task, task);
  inProcessQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test-only: reset the in-process queue between tests. */
export function __resetInProcessQueue(): void {
  inProcessQueue = Promise.resolve();
}

// ---------------------------------------------------------------------------
// Read (tolerant; never holds a handle)
// ---------------------------------------------------------------------------

/**
 * Read all events, dropping malformed lines (a torn last line on crash) and
 * duplicate event ids. Opens, reads and closes — it never keeps a handle, so a
 * compaction rename can never hit a held file (M1).
 */
export function readEvents(logPath: string): ExchangeEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const seen = new Set<string>();
  const out: ExchangeEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: ExchangeEvent;
    try {
      parsed = JSON.parse(line) as ExchangeEvent;
    } catch {
      continue; // torn or malformed: dropped on read (tolerant parse)
    }
    if (typeof parsed.eventId !== 'string' || seen.has(parsed.eventId)) continue;
    seen.add(parsed.eventId);
    out.push(parsed);
  }
  return out;
}

/** Group events by exchange, preserving log order. */
export function groupByExchange(events: readonly ExchangeEvent[]): Map<string, ExchangeEvent[]> {
  const map = new Map<string, ExchangeEvent[]>();
  for (const e of events) {
    const arr = map.get(e.exchangeId);
    if (arr) arr.push(e);
    else map.set(e.exchangeId, [e]);
  }
  return map;
}

/** Latest state per exchange, derived (never stored). */
export function latestStates(events: readonly ExchangeEvent[]): Map<string, ExchangeState> {
  const map = new Map<string, ExchangeState>();
  for (const [exchangeId, evs] of groupByExchange(events)) {
    const s = deriveLatestState(evs);
    if (s !== undefined) map.set(exchangeId, s);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append one event under the in-process queue and the interprocess lock.
 * `seq` is assigned from the current log length (recomputed under the lock so
 * two processes cannot mint the same seq).
 *
 * F-03: the transition is validated against the exchange's current derived
 * state before it is recorded. An illegal transition (e.g. a late `completed`
 * after a terminal `timeout`) is REJECTED — not appended — so the board can
 * never report a success for an exchange that already timed out. A brand-new
 * exchange has no prior state, so its first event is checked from the implicit
 * `created` state.
 */
export function appendEvent(
  paths: ExchangeLogPaths,
  event: Omit<ExchangeEvent, 'seq'>,
  deps: ExchangeLogDeps = {},
): Promise<void> {
  return enqueue(async () => {
    const holder = getHostIdentity(deps);
    const deadline = Date.now() + (deps.lockTimeoutMs ?? 5_000);
    acquireLock(paths.lock, holder, deps, deadline);
    try {
      const existing = readEvents(paths.log);
      // F-03: a terminal state is FINAL. A new event for an exchange that has
      // already reached a terminal state (a `completed` that arrives after the
      // non-terminal deadline wrote `timeout`, a duplicate completion) is an
      // ORPHAN — it is not recorded, so the board can never report a success
      // for an exchange that already timed out. A brand-new exchange (no prior
      // events) and any event while the exchange is still non-terminal are
      // recorded: the latter includes the relay's two `accepted` hops and a
      // non-advancing re-accept, which are distinct events, not transitions.
      // The read side enforces the same rule: `deriveLatestState` stops at the
      // first terminal state, so even a stray late event cannot flip a terminal
      // exchange back to a live one.
      const prior = existing.filter((e) => e.exchangeId === event.exchangeId);
      if (prior.length > 0) {
        const current = deriveLatestState(prior) as ExchangeState;
        if (isTerminal(current)) return; // orphan: the exchange is already over
        // A `verdict` event completes a non-observing exchange that honestly
        // stays at `accepted`/`observed` until the agent writes its verdict
        // (F-03). That is an exchange-correlated completion, not a transport
        // exit, so it is the one case allowed to jump to `completed` from a
        // non-started state. Everything else must follow the strict table.
        const isVerdictCompletion =
          event.type === 'verdict' &&
          event.state === 'completed' &&
          (current === 'accepted' || current === 'observed');
        if (
          event.state !== current &&
          !isVerdictCompletion &&
          !canTransition(current, event.state)
        ) {
          throw new Error(`illegal exchange transition ${current} -> ${event.state}`);
        }
      }
      const seq = existing.length > 0 ? Math.max(...existing.map((e) => e.seq)) + 1 : 1;
      const full: ExchangeEvent = { ...event, seq };
      fs.mkdirSync(path.dirname(paths.log), { recursive: true });
      await fs.promises.appendFile(paths.log, `${JSON.stringify(full)}\n`, 'utf8');
    } finally {
      releaseLock(paths.lock, holder);
    }
  });
}

// ---------------------------------------------------------------------------
// Compaction (M8)
// ---------------------------------------------------------------------------

export interface CompactionOptions {
  now?: number;
  maxExchanges?: number;
  ttlMs?: number;
  nonTerminalDeadlineMs?: number;
}

export interface CompactionResult {
  /** Exchanges removed (whole, terminal). */
  removedExchanges: number;
  /** Events removed. */
  removedEvents: number;
  /** Non-terminal exchanges that hit their deadline and got a `timeout` event. */
  timedOut: string[];
}

/**
 * Compact the log to the last N terminal exchanges (plus the 24 h TTL backstop),
 * keeping every non-terminal exchange (M8). A non-terminal exchange whose latest
 * event is older than the deadline first gets a terminal `timeout` event, then
 * becomes eligible. Runs under the interprocess lock; rewrites to a tmp file and
 * renames it over the log. A failed rename leaves the old log in place.
 */
export function compact(
  paths: ExchangeLogPaths,
  options: CompactionOptions = {},
  deps: ExchangeLogDeps = {},
): Promise<CompactionResult> {
  return enqueue(async () => {
    const now = options.now ?? Date.now();
    const maxExchanges = options.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const deadlineMs = options.nonTerminalDeadlineMs ?? NON_TERMINAL_DEADLINE_MS;
    const holder = getHostIdentity(deps);
    const deadline = Date.now() + (deps.lockTimeoutMs ?? 5_000);
    acquireLock(paths.lock, holder, deps, deadline);
    try {
      const events = readEvents(paths.log);
      const groups = groupByExchange(events);
      const states = latestStates(events);

      // M8: give past-deadline non-terminal exchanges a terminal timeout event.
      const timedOut: string[] = [];
      const extra: ExchangeEvent[] = [];
      let nextSeq = events.length > 0 ? Math.max(...events.map((e) => e.seq)) + 1 : 1;
      for (const [exchangeId, evs] of groups) {
        const state = states.get(exchangeId);
        if (state === undefined || isTerminal(state)) continue;
        const lastTs = Math.max(...evs.map((e) => e.ts));
        if (now - lastTs > deadlineMs) {
          timedOut.push(exchangeId);
          extra.push({
            seq: nextSeq++,
            eventId: `timeout-${exchangeId}`, // deterministic → idempotent on replay
            ts: now,
            exchangeId,
            workspace: evs[evs.length - 1].workspace,
            ...(evs[evs.length - 1].conversation
              ? { conversation: evs[evs.length - 1].conversation }
              : {}),
            from: evs[evs.length - 1].from,
            ...(evs[evs.length - 1].to ? { to: evs[evs.length - 1].to } : {}),
            type: 'state',
            state: 'timeout',
            detail: 'non-terminal deadline reached; no further event',
          });
        }
      }

      const allEvents = [...events, ...extra];
      const allGroups = groupByExchange(allEvents);
      const allStates = latestStates(allEvents);

      // Partition: non-terminal always kept; terminal subject to last-N + TTL.
      const terminal: { id: string; lastTs: number }[] = [];
      for (const [id, s] of allStates) {
        if (isTerminal(s)) {
          const evs = allGroups.get(id) as ExchangeEvent[];
          terminal.push({ id, lastTs: Math.max(...evs.map((e) => e.ts)) });
        }
      }
      terminal.sort((a, b) => b.lastTs - a.lastTs);
      const keep = new Set<string>();
      terminal.forEach((t, i) => {
        const tooOld = now - t.lastTs > ttlMs;
        // Keep if within last-N OR (not past the TTL backstop). Drop only when
        // outside last-N AND past the TTL — last-N is the primary, TTL the
        // backstop that also cleans a small-but-old log.
        if (i < maxExchanges || !tooOld) keep.add(t.id);
      });

      // A terminal exchange is dropped only if it is in neither keep nor
      // non-terminal. Non-terminal exchanges are always kept.
      const keepAll = new Set(keep);
      for (const [id, s] of allStates) if (!isTerminal(s)) keepAll.add(id);

      const keptEvents = allEvents.filter((e) => keepAll.has(e.exchangeId));
      const removedEvents = allEvents.length - keptEvents.length;
      const removedExchanges = allGroups.size - new Set(keptEvents.map((e) => e.exchangeId)).size;

      if (removedEvents === 0 && timedOut.length === 0) {
        return { removedExchanges: 0, removedEvents: 0, timedOut };
      }

      // Rewrite to a tmp file and rename over the log (M1). Readers open/read/
      // close, so a held handle is not the failure mode; a failed rename leaves
      // the old log in place and the next compaction retries.
      const tmp = `${paths.log}.tmp`;
      const body = keptEvents.map((e) => JSON.stringify(e)).join('\n');
      fs.writeFileSync(tmp, body === '' ? '' : `${body}\n`, 'utf8');
      try {
        fs.renameSync(tmp, paths.log);
      } catch (err) {
        unlinkQuietFile(tmp);
        throw err;
      }
      return { removedExchanges, removedEvents, timedOut };
    } finally {
      releaseLock(paths.lock, holder);
    }
  });
}

/** A fresh event id (UUID). */
export function newEventId(): string {
  return randomUUID();
}
