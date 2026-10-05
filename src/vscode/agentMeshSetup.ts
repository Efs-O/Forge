import * as vscode from 'vscode';
import * as path from 'path';
import { busPaths } from '../agentBus/agentBus';
import type { ForgeConfig } from '../config/types';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { listAliases } from '../agentMesh/aliasRegistry';
import { isTerminal, type ExchangeState } from '../agentMesh/deliveryState';
import {
  appendEvent,
  EXCHANGES_LOCK_NAME,
  EXCHANGES_LOG_NAME,
  NON_TERMINAL_DEADLINE_MS,
  newEventId,
  readEvents,
  type ExchangeLogPaths,
} from '../agentMesh/exchangeLog';
import { listOwnedAliases } from '../agentMesh/ownership';
import { MeshOrchestrator } from '../agentMesh/meshOrchestrator';
import { meshEventNotification } from '../agentMesh/meshNotificationPolicy';
import { PendingHostActivity } from '../agentMesh/pendingHostActivity';
import { MeshSessionProvider } from '../agentMesh/sessionProvider';
import { setBoardContext, setMeshOrchestrator } from '../agentMesh/meshContext';
import { TurnStatus } from '../agentMesh/turnStatus';
import { validateInboundSender } from '../agentMesh/senderValidation';
import { createMeshMaintenance } from './meshMaintenance';
import { renderMeshObservation } from './meshObservation';
import { createMeshVerdictPoll } from './meshVerdictPoll';

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
    originConversation?: string,
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

export function setupAgentMesh(
  context: vscode.ExtensionContext,
  getSidebar: () => { getHostFacade(): ForgeHostFacade },
  getConfig: () => ForgeConfig,
  workspaceRoot: string,
  home?: string,
): AgentMesh {
  // F-08: a user who disabled the bus must not run mesh startup recovery (the
  // ledger's disable row). The routes are already gated on `agent_bus.enabled`;
  // this gates the mesh's own durable-state work the same way.
  if (getConfig().agent_bus?.enabled !== true) {
    return disabledMesh();
  }

  const paths = busPaths(home);
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

  // A11: buffer terminal notifications until the delivery path is ready.
  const pendingActivities = new PendingHostActivity(() => getSidebar().getHostFacade());

  // F-03: board events are DURABLE before a tell/relay returns. `onEvent`
  // awaits the append so the accepted state is on disk before the caller is
  // told the exchange exists — a crash after the return cannot lose it.
  const onEvent: (e: {
    eventId?: string;
    exchangeId: string;
    from: string;
    to?: string;
    type: string;
    state: ExchangeState;
    detail?: string;
    originConversation?: string;
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
      const appended = await appendEvent(
        exchangePaths,
        {
          eventId: e.eventId ?? newEventId(),
          ts: Date.now(),
          exchangeId: e.exchangeId,
          workspace: s.workspace,
          ...(s.conversation ? { conversation: s.conversation } : {}),
          from: e.from,
          ...(e.to ? { to: e.to } : {}),
          type: e.type,
          state: e.state,
          ...(e.detail ? { detail: e.detail } : {}),
          ...(e.originConversation ? { originConversation: e.originConversation } : {}),
        },
        {},
      );
      if (!appended) return;
    } catch (err) {
      vscode.window.showErrorMessage(`[agent mesh] could not write a board event: ${String(err)}`);
      throw err;
    }
    const notification = meshEventNotification(e, s);
    if (notification) pendingActivities.enqueue(notification);
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
    // A stand-in answering for a dead joined Claude is never silent: the
    // window, every paired chat, and the board all say so.
    onStandIn: (alias, note) => {
      void vscode.window.showWarningMessage(note);
      void onEvent({
        exchangeId: `stand-in-${alias}-${Date.now()}`,
        from: 'forge',
        to: alias,
        type: 'notice',
        state: 'recovered',
        detail: note,
      });
    },
  });

  const knownAliases = (): string[] => {
    return knownAliasesForMesh(paths.root, getConfig().agent_bus);
  };

  const renderObservation = (verb: 'status' | 'board' | 'peers' | 'queue' | 'context'): string =>
    renderMeshObservation(verb, {
      scope,
      logPath: exchangePaths.log,
      root: paths.root,
      aliases: () => orchestrator.aliases(),
      queueLength: (alias) => orchestrator.queueLength(alias),
    });
  const orchestrator = new MeshOrchestrator({
    busRoot: paths.root,
    provider,
    scope,
    onEvent,
    knownAliases,
    verdictDir: outboxDir,
    onObservation: renderObservation,
    onMessageAccepted: ({ exchangeId, from, to, message, priority }) => {
      const s = scope();
      const verb = priority === 'steer' ? 'steers' : 'says to';
      getSidebar()
        .getHostFacade()
        .emitHostActivity?.({
          ...(s.conversation ? { conversationId: s.conversation } : {}),
          text: `[agent mesh ${exchangeId}] ${from} ${verb} ${to}:\n\n${message}`,
        });
    },
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

  const maintenance = createMeshMaintenance({
    root: paths.root,
    exchangePaths,
    provider,
    turnStatus,
    onEvent,
  });
  const verdictPoll = createMeshVerdictPoll({ outboxDir, exchangePaths, onEvent });
  maintenance.start();
  verdictPoll.start();

  const relay: AgentMesh['relay'] = async (from, to, text, originConversation) => {
    const result = await orchestrator.relay(from, to, text, 0, originConversation);
    if ('error' in result) return { ok: false, error: result.error };
    return {
      ok: true,
      exchangeId: result.exchangeId,
      ...(result.deliveredTo ? { deliveredTo: result.deliveredTo } : {}),
    };
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
    maintenance.dispose();
    verdictPoll.dispose();
    orchestrator.dispose();
    pendingActivities.dispose();
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
