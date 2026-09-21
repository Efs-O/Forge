import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { busPaths } from '../agentBus/agentBus';
import type { ForgeConfig } from '../config/types';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { listAliases } from '../agentMesh/aliasRegistry';
import { isTerminal, type ExchangeState } from '../agentMesh/deliveryState';
import {
  appendEvent,
  compact,
  EXCHANGES_LOCK_NAME,
  EXCHANGES_LOG_NAME,
  NON_TERMINAL_DEADLINE_MS,
  newEventId,
  groupByExchange,
  latestStates,
  readEvents,
  type ExchangeLogPaths,
} from '../agentMesh/exchangeLog';
import {
  listOwnedAliases,
  readOwnership,
  recoverOwnership,
  writeOwnership,
} from '../agentMesh/ownership';
import { MeshOrchestrator } from '../agentMesh/meshOrchestrator';
import { MeshSessionProvider } from '../agentMesh/sessionProvider';
import { projectBoard, projectLiveSessions } from '../agentMesh/boardView';
import { setBoardContext, setMeshOrchestrator } from '../agentMesh/meshContext';
import { TurnStatus } from '../agentMesh/turnStatus';
import { validateInboundSender } from '../agentMesh/senderValidation';

/** Agent-mesh activation wiring: durable board, recovery, relay, and lifecycle timers. */

export function knownAliasesForMesh(root: string, agentBus: ForgeConfig['agent_bus']): string[] {
  const set = new Set<string>(['forge']);
  for (const alias of Object.keys(listAliases(root))) set.add(alias);
  // A fresh owned Codex has no thread id until app-server startup completes,
  // so its alias may not yet be present in aliases.json. Ownership itself is
  // enough to make the stable alias routable by send/steer.
  for (const alias of listOwnedAliases(root)) set.add(alias);
  if (agentBus?.codex_thread) set.add('codex');
  if (agentBus?.claude_session) set.add('claude');
  return [...set];
}

export interface AgentMesh {
  orchestrator: MeshOrchestrator;
  provider: MeshSessionProvider;
  /** The host-side relay (M6), wired into the inbound routes. */
  relay: (
    from: string,
    to: string,
    text: string,
  ) => Promise<{ ok: true; exchangeId: string } | { ok: false; error: string }>;
  /** F-06: a `priority=steer` relay (interrupts the active turn). */
  steer: (
    from: string,
    to: string,
    text: string,
  ) => Promise<{ ok: true; exchangeId: string } | { ok: false; error: string }>;
  /** Validate an inbound sender alias (M6/§4); unknown `from` is rejected. */
  validateFrom: (from: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** F-08: mark a bus-started turn in flight (writes status/<turn>.json). */
  markTurnStarted: (turnId: string) => void;
  /** F-08: mark a bus turn finished (deletes status/<turn>.json). */
  markTurnFinished: (turnId: string) => void;
  /** Dispose owned sessions + FIFOs + timers (extension deactivate). */
  dispose: () => Promise<void>;
}

/** A no-op mesh when the agent bus is disabled (the ledger's disable row). */
function disabledMesh(): AgentMesh {
  const reject = async () => ({ ok: false as const, error: 'agent bus is disabled' });
  return {
    orchestrator: undefined as unknown as MeshOrchestrator,
    provider: undefined as unknown as MeshSessionProvider,
    relay: reject,
    steer: reject,
    validateFrom: async () => ({ ok: false, error: 'agent bus is disabled' }),
    markTurnStarted: () => undefined,
    markTurnFinished: () => undefined,
    dispose: async () => undefined,
  };
}

/** How often the compaction / verdict / idle-TTL timers run (ms). */
const MAINTENANCE_INTERVAL_MS = 60_000;
/** An owned session idle longer than this (and not parked) is reaped (F-07). */
const IDLE_TTL_MS = 2 * 60 * 60_000;

export function setupAgentMesh(
  context: vscode.ExtensionContext,
  getSidebar: () => { getHostFacade(): ForgeHostFacade },
  getConfig: () => ForgeConfig,
  workspaceRoot: string,
): AgentMesh {
  // F-08: a user who disabled the bus must not run mesh startup recovery (the
  // ledger's disable row). The routes are already gated on `agent_bus.enabled`;
  // this gates the mesh's own durable-state work the same way.
  if (getConfig().agent_bus?.enabled !== true) {
    return disabledMesh();
  }

  const paths = busPaths();
  const exchangePaths: ExchangeLogPaths = {
    log: path.join(paths.root, EXCHANGES_LOG_NAME),
    lock: path.join(paths.root, EXCHANGES_LOCK_NAME),
  };
  const outboxDir = paths.outbox;
  const statusDir = path.join(paths.root, 'status');
  // P2: the Telegram /status handler reads this to render the board.
  setBoardContext({ root: paths.root, workspace: workspaceRoot, log: exchangePaths.log });

  const scope = (): { workspace: string; conversation?: string } => {
    let conversation: string | undefined;
    try {
      const status = getSidebar().getHostFacade().status();
      conversation = status.activeConversationId;
    } catch {
      conversation = undefined; // sidebar not up yet: workspace-scoped only
    }
    return { workspace: workspaceRoot, ...(conversation ? { conversation } : {}) };
  };

  // M9: an exchange inherits the scope of its FIRST event. Reading the active
  // conversation per event would split an exchange that is accepted in
  // conversation A and completed after the user switches to B — leaking or
  // hiding board lines across conversations. The first event's scope wins.
  //
  // The map is bounded two ways: (1) a terminal event deletes its entry, and
  // (2) a non-terminal exchange older than the M8 deadline — the same window
  // the log uses to turn it into a terminal `timeout` — is swept on the next
  // event, so a non-observing exchange that stays `accepted` forever cannot
  // grow the map without bound.
  const exchangeScope = new Map<
    string,
    { scope: { workspace: string; conversation?: string }; firstEventAt: number }
  >();

  const sweepStaleScopes = (): void => {
    const now = Date.now();
    for (const [id, entry] of exchangeScope) {
      if (now - entry.firstEventAt > NON_TERMINAL_DEADLINE_MS) exchangeScope.delete(id);
    }
  };

  // F-03: board events are DURABLE before a tell/relay returns. `onEvent`
  // awaits the append so the accepted state is on disk before the caller is
  // told the exchange exists — a crash after the return cannot lose it.
  const onEvent: (e: {
    exchangeId: string;
    from: string;
    to?: string;
    type: string;
    state: ExchangeState;
    detail?: string;
  }) => Promise<void> = async (e) => {
    sweepStaleScopes();
    const existing = exchangeScope.get(e.exchangeId);
    const prior = existing
      ? undefined
      : readEvents(exchangePaths.log).find((event) => event.exchangeId === e.exchangeId);
    const s =
      existing?.scope ??
      (prior
        ? {
            workspace: prior.workspace,
            ...(prior.conversation ? { conversation: prior.conversation } : {}),
          }
        : scope());
    if (!existing) exchangeScope.set(e.exchangeId, { scope: s, firstEventAt: Date.now() });
    try {
      await appendEvent(
        exchangePaths,
        {
          eventId: newEventId(),
          ts: Date.now(),
          exchangeId: e.exchangeId,
          workspace: s.workspace,
          ...(s.conversation ? { conversation: s.conversation } : {}),
          from: e.from,
          ...(e.to ? { to: e.to } : {}),
          type: e.type,
          state: e.state,
          ...(e.detail ? { detail: e.detail } : {}),
        },
        {},
      );
    } catch (err) {
      vscode.window.showErrorMessage(`[agent mesh] could not write a board event: ${String(err)}`);
      throw err;
    }
    // The exchange is over at a terminal state: its scope is no longer needed,
    // so the map is bounded to in-flight exchanges only.
    if (isTerminal(e.state)) exchangeScope.delete(e.exchangeId);
  };

  const provider = new MeshSessionProvider({
    busRoot: paths.root,
    getConfig,
    workspaceRoots: () => (workspaceRoot ? [workspaceRoot] : []),
    // M3: a failed thread resume is a visible context loss, never a silent
    // fresh thread.
    onContextLost: (alias, reason) => {
      void onEvent({
        exchangeId: `context-lost-${alias}`,
        from: 'forge',
        to: alias,
        type: 'notice',
        state: 'context_lost',
        detail: `thread resume failed: ${reason}`,
      });
    },
  });

  const knownAliases = (): string[] => {
    return knownAliasesForMesh(paths.root, getConfig().agent_bus);
  };

  // F-09: render the observational commands (status/board/peers/queue/context)
  // into real scoped state, not a placeholder. The wiring layer knows the
  // scope and board projection, so it renders; the orchestrator dispatches.
  const renderObservation = (verb: 'status' | 'board' | 'peers' | 'queue' | 'context'): string => {
    const s = scope();
    switch (verb) {
      case 'status':
      case 'board': {
        const rows = projectBoard(exchangePaths.log, s.workspace, s.conversation, 5);
        const sessions = projectLiveSessions(paths.root);
        const board = rows
          .map((r) => `${r.from}→${r.to ?? '?'}: ${r.label}${r.detail ? ` (${r.detail})` : ''}`)
          .join('; ');
        const live = sessions.map((ls) => `${ls.alias}[${ls.state}]`).join(', ');
        return `board: ${board || 'empty'}\nlive: ${live || 'none'}`;
      }
      case 'peers': {
        const sessions = projectLiveSessions(paths.root);
        return `peers: ${sessions.map((ls) => `${ls.alias}[${ls.state}]`).join(', ') || 'none'}`;
      }
      case 'queue': {
        // F-09: the mesh FIFO pending per alias (agent-bus messages), not just
        // the remote conversation queue.
        const parts: string[] = [];
        for (const alias of orchestrator.aliases()) {
          if (alias === 'forge') continue;
          const n = orchestrator.queueLength(alias);
          if (n > 0) parts.push(`${alias}: ${n}`);
        }
        return `queue: ${parts.join(', ') || 'empty'}`;
      }
      case 'context':
        return `context: workspace=${s.workspace}${s.conversation ? ` conversation=${s.conversation}` : ' (unbound)'}`;
    }
  };

  const orchestrator = new MeshOrchestrator({
    busRoot: paths.root,
    provider,
    scope,
    onEvent,
    knownAliases,
    verdictDir: outboxDir,
    onObservation: renderObservation,
  });
  setMeshOrchestrator(orchestrator);
  // F-08: status files are written while bus turns run and swept after a crash.
  const turnStatus = new TurnStatus(statusDir);
  let activeTurnId: string | undefined;
  // Exposed so the wiring (agentMessagingSetup) can mark a bus turn in flight.
  const markTurnStarted = (turnId: string): void => {
    activeTurnId = turnId;
    turnStatus.markTurnStarted(turnId, 'bus turn in flight');
  };
  const markTurnFinished = (turnId: string): void => {
    if (activeTurnId === turnId) activeTurnId = undefined;
    turnStatus.markTurnFinished(turnId);
  };

  // Startup recovery reaps dead owners, records the crash, and times out their
  // accepted-but-not-started FIFO exchanges. A null owner is a clean close.
  void (async () => {
    try {
      const recovery = recoverOwnership(paths.root);
      for (const action of recovery.actions) {
        if (action.action !== 'reaped') continue;
        await provider.reap(action.alias);
        await onEvent({
          exchangeId: `crash-${action.alias}`,
          from: 'forge',
          to: action.alias,
          type: 'notice',
          state: 'crashed',
          detail: 'owned session lost; thread kept for resume',
        });
        // F-08: the dead owner's in-memory FIFO is gone. Terminalize every
        // accepted message addressed to this alias immediately instead of
        // leaving a lost message looking live until the 24-hour compaction
        // deadline.
        const events = readEvents(exchangePaths.log);
        const states = latestStates(events);
        for (const [exchangeId, exchangeEvents] of groupByExchange(events)) {
          if (states.get(exchangeId) !== 'accepted') continue;
          if (!exchangeEvents.some((event) => event.to?.toLowerCase() === action.alias)) continue;
          await onEvent({
            exchangeId,
            from: 'forge',
            to: action.alias,
            type: 'state',
            state: 'timeout',
            detail: 'owner host died before the queued message started',
          });
        }
      }
    } catch {
      // Recovery is best-effort; a failure here must not block activation.
    } finally {
      // F-08: clear only status files whose owning host is proven dead. A
      // second extension window may have a live turn in the shared directory.
      turnStatus.sweepDead();
    }
  })();

  // F-07: bounded compaction and idle-TTL maintenance; parked sessions are exempt.
  const runMaintenance = async (): Promise<void> => {
    try {
      await compact(exchangePaths, {}, {});
      // Idle-TTL reap: an owned session with no recent activity (and not
      // parked) is disposed, keeping its thread_id for resume (M3).
      for (const alias of listOwnedAliases(paths.root)) {
        const rec = readOwnership(paths.root, alias);
        if (!rec) continue;
        if (rec.parked) continue; // park-but-warm: exempt (M4)
        // F-02: reap only a session THIS window owns. An idle session owned by
        // another live window is not ours to reap — nulling its owner record
        // would orphan the live process that window holds and let a later
        // message spawn a duplicate.
        if (!provider.isOwner(alias)) continue;
        const last = rec.last_activity ?? rec.created_at;
        if (Date.now() - last > IDLE_TTL_MS) {
          await provider.reap(alias);
          writeOwnership(paths.root, { ...rec, owner_host: null, parked: false });
          await onEvent({
            exchangeId: `idle-${alias}`,
            from: 'forge',
            to: alias,
            type: 'notice',
            state: 'timeout',
            detail: 'idle TTL reached; session reaped, thread kept for resume',
          });
        }
      }
    } catch {
      // Maintenance is best-effort; a failure must not crash the host.
    }
  };
  let maintenanceRun: Promise<void> | undefined;
  const maintenanceTimer = setInterval(() => {
    if (maintenanceRun) return;
    maintenanceRun = runMaintenance().finally(() => {
      maintenanceRun = undefined;
    });
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();

  // F-03: consume exchange-correlated verdicts for non-observing sends; late or
  // unknown verdicts are discarded as orphans.
  const pollVerdictsOnce = async (): Promise<void> => {
    let names: string[];
    try {
      names = fs.readdirSync(outboxDir);
    } catch {
      return; // no outbox yet
    }
    const states = latestStates(readEvents(exchangePaths.log));
    for (const name of names) {
      if (!name.endsWith('.verdict.md')) continue;
      const exchangeId = name.slice(0, -'.verdict.md'.length);
      const file = path.join(outboxDir, name);
      const state = states.get(exchangeId);
      // A verdict is only meaningful for an exchange already accepted by the
      // mesh. Unknown files and verdicts for terminal exchanges are orphans;
      // consume them once without creating a false completed exchange.
      if (state === undefined || isTerminal(state) || state === 'created') {
        try {
          fs.unlinkSync(file);
        } catch {
          // Absent: another window consumed the orphan.
        }
        void vscode.window.showWarningMessage(
          `[agent mesh] ignored orphan verdict for exchange ${exchangeId}`,
        );
        continue;
      }
      let body = '';
      try {
        body = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      await onEvent({
        exchangeId,
        from: 'forge',
        type: 'verdict',
        state: 'completed',
        detail: body.slice(0, 500),
      });
      try {
        fs.unlinkSync(file);
      } catch {
        // Absent: another window consumed it.
      }
    }
  };
  let verdictPoll: Promise<void> | undefined;
  const pollVerdicts = (): Promise<void> => {
    if (verdictPoll) return verdictPoll;
    verdictPoll = pollVerdictsOnce().finally(() => {
      verdictPoll = undefined;
    });
    return verdictPoll;
  };
  const verdictTimer = setInterval(() => void pollVerdicts(), MAINTENANCE_INTERVAL_MS);
  verdictTimer.unref?.();

  const relay: AgentMesh['relay'] = async (from, to, text) => {
    const result = await orchestrator.relay(from, to, text);
    if ('error' in result) return { ok: false, error: result.error };
    return { ok: true, exchangeId: result.exchangeId };
  };

  // F-06: a `priority=steer` relay interrupts the recipient's active turn.
  const steer: AgentMesh['steer'] = async (_from, to, text) => {
    const result = await orchestrator.steer(to, text);
    if ('error' in result) return { ok: false, error: result.error };
    return { ok: true, exchangeId: result.exchangeId };
  };

  const validateFrom: AgentMesh['validateFrom'] = (from) =>
    validateInboundSender(
      from,
      (value) => orchestrator.validateFrom(value),
      paths.root,
      getConfig,
      workspaceRoot,
      () => orchestrator.aliases(),
    );

  const dispose = async (): Promise<void> => {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    if (verdictTimer) clearInterval(verdictTimer);
    orchestrator.dispose();
    await provider.dispose();
    if (activeTurnId) turnStatus.markTurnFinished(activeTurnId);
    setMeshOrchestrator(undefined);
    setBoardContext(undefined);
  };
  context.subscriptions.push({ dispose: () => void dispose() });

  return {
    orchestrator,
    provider,
    relay,
    steer,
    validateFrom,
    markTurnStarted,
    markTurnFinished,
    dispose,
  };
}
