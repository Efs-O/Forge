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

/**
 * Agent-mesh activation wiring (AGENT_MESH_PLAN P0). Creates the orchestrator
 * (the single entry point for `tell` and the host-side relay M6) and the
 * session provider (the M2 owner of in-memory owned sessions), wires board
 * events to the exchange log, runs startup recovery (M2/M3), and exposes a
 * `relay` for the inbound routes.
 *
 * `getSidebar` is lazy: activation creates the control server before the
 * sidebar exists. The board scope reads the active conversation lazily, so an
 * event written before the sidebar is up is workspace-scoped only (M9: an
 * event with no conversation is sidebar-only, never Telegram).
 *
 * F-01: a first Forge-owned creation is a user-visible, one-time consented
 * privileged spawn. The wiring supplies the consent gate (a VS Code
 * confirmation); the provider refuses a first creation when none is supplied.
 * F-03: board events are durable before a tell/relay returns, and a verdict
 * poller completes non-observing exchanges. F-07: a compaction scheduler keeps
 * the log bounded and an idle-TTL reaper reaps long-idle owned sessions.
 */

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
  validateFrom: (from: string) => { ok: true } | { ok: false; error: string };
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
    validateFrom: () => ({ ok: false, error: 'agent bus is disabled' }),
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
    const s = existing?.scope ?? scope();
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
    }
    // The exchange is over at a terminal state: its scope is no longer needed,
    // so the map is bounded to in-flight exchanges only.
    if (isTerminal(e.state)) exchangeScope.delete(e.exchangeId);
  };

  // F-01: the one-time, user-visible consent gate for a first Forge-owned
  // creation. A privileged spawn (a long-lived Claude/Codex process this window
  // owns) is never started silently. The gate is per-alias and remembered for
  // the session; a refusal is surfaced, not retried silently.
  const consented = new Set<string>();
  const requestConsent = async (alias: string): Promise<boolean> => {
    if (consented.has(alias)) return true;
    const action = await vscode.window.showWarningMessage(
      `Forge wants to create a persistent, owned "${alias}" session (a long-lived ` +
        `process this window owns, resumable across restarts). Allow?`,
      { modal: true },
      'Allow',
      'Cancel',
    );
    if (action === 'Allow') {
      consented.add(alias);
      return true;
    }
    return false;
  };

  const provider = new MeshSessionProvider({
    busRoot: paths.root,
    getConfig,
    workspaceRoots: () => (workspaceRoot ? [workspaceRoot] : []),
    // F-01: the consent gate. A first creation without it is refused.
    requestConsent,
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
    const bus = getConfig().agent_bus;
    const set = new Set<string>(['forge']);
    for (const alias of Object.keys(listAliases(paths.root))) set.add(alias);
    if (bus?.codex_thread) set.add('codex');
    if (bus?.claude_session) set.add('claude');
    return [...set];
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
  // F-08: the bus-turn status file. While a bus-started turn runs, the sender
  // can see it is in flight; it is deleted at terminal completion. The normal
  // in-process finished notice lives in agentMessagingSetup; this is the
  // crash-recovery half (a turn whose owner host died is terminalized below).
  let activeTurnId: string | undefined;
  const writeStatusFile = (turnId: string, detail: string): void => {
    try {
      fs.mkdirSync(statusDir, { recursive: true });
      fs.writeFileSync(
        path.join(statusDir, `${turnId}.json`),
        `${JSON.stringify({ turnId, ts: Date.now(), detail }, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // Best-effort; a status-file failure must not block a turn.
    }
  };
  const clearStatusFile = (turnId: string): void => {
    try {
      fs.unlinkSync(path.join(statusDir, `${turnId}.json`));
    } catch {
      // Absent: nothing to clear.
    }
  };
  // Exposed so the wiring (agentMessagingSetup) can mark a bus turn in flight.
  const markTurnStarted = (turnId: string): void => {
    activeTurnId = turnId;
    writeStatusFile(turnId, 'bus turn in flight');
  };
  const markTurnFinished = (turnId: string): void => {
    if (activeTurnId === turnId) activeTurnId = undefined;
    clearStatusFile(turnId);
  };

  // Startup recovery (M2/M3, F-02, F-08): reap a dead owner host's session
  // (keeping its thread_id for resume), write a `crashed` board event
  // (idempotent by event id), and terminalize that owner's accepted-but-not-
  // started FIFO exchanges as `timeout`. A record whose owner is already null
  // is a clean close, not a crash (F-02), so it produces no crash event.
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
        // F-08: the dead owner's in-memory FIFO is gone, so its
        // accepted-but-not-started exchanges are lost messages. They are
        // terminalized as `timeout` by the compaction loop (a past-deadline
        // non-terminal exchange gets a deterministic `timeout` event); the
        // board never shows them as in-flight forever.
      }
      // F-08: a status file left by a crashed bus turn is stale — clear it.
      try {
        for (const name of fs.readdirSync(statusDir)) {
          if (name.endsWith('.json')) fs.unlinkSync(path.join(statusDir, name));
        }
      } catch {
        // Absent: nothing to clear.
      }
    } catch {
      // Recovery is best-effort; a failure here must not block activation.
    }
  })();

  // F-07: a bounded maintenance loop. Every interval it (1) compacts the log
  // to the last-N terminal exchanges (turning past-deadline non-terminal
  // exchanges into `timeout`), and (2) reaps owned sessions idle longer than
  // the TTL (keeping thread_id for resume; parked sessions are exempt).
  const runMaintenance = async (): Promise<void> => {
    try {
      await compact(exchangePaths, {}, {});
      // Idle-TTL reap: an owned session with no recent activity (and not
      // parked) is disposed, keeping its thread_id for resume (M3).
      for (const alias of listOwnedAliases(paths.root)) {
        const rec = readOwnership(paths.root, alias);
        if (!rec) continue;
        if (rec.parked) continue; // park-but-warm: exempt (M4)
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
  const maintenanceTimer = setInterval(() => void runMaintenance(), MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();

  // F-03: the verdict poller. A non-observing exchange (a user-opened session
  // reached by `codex queue` / a peer pipe) stays `accepted` until a verdict
  // appears. The verdict file is named `<exchangeId>.verdict.md` in the outbox
  // (the exchange id is bound into the message by the orchestrator). When it
  // appears, the exchange is completed — an exchange-correlated verdict, not a
  // transport exit code. A late verdict after the exchange timed out is an
  // orphan: the terminal `timeout` is final (the log rejects the transition).
  const pollVerdicts = async (): Promise<void> => {
    let names: string[];
    try {
      names = fs.readdirSync(outboxDir);
    } catch {
      return; // no outbox yet
    }
    for (const name of names) {
      if (!name.endsWith('.verdict.md')) continue;
      const exchangeId = name.slice(0, -'.verdict.md'.length);
      const file = path.join(outboxDir, name);
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

  const validateFrom: AgentMesh['validateFrom'] = (from) => orchestrator.validateFrom(from);

  const dispose = async (): Promise<void> => {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    if (verdictTimer) clearInterval(verdictTimer);
    orchestrator.dispose();
    await provider.dispose();
    if (activeTurnId) clearStatusFile(activeTurnId);
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
