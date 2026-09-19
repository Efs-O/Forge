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
  newEventId,
  type ExchangeLogPaths,
} from '../agentMesh/exchangeLog';
import { recoverOwnership } from '../agentMesh/ownership';
import { MeshOrchestrator } from '../agentMesh/meshOrchestrator';
import { MeshSessionProvider } from '../agentMesh/sessionProvider';
import { setMeshOrchestrator } from '../agentMesh/meshContext';

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
  /** Validate an inbound sender alias (M6/§4); unknown `from` is rejected. */
  validateFrom: (from: string) => { ok: true } | { ok: false; error: string };
  /** Dispose owned sessions + FIFOs (extension deactivate). */
  dispose: () => Promise<void>;
}

export function setupAgentMesh(
  context: vscode.ExtensionContext,
  getSidebar: () => { getHostFacade(): ForgeHostFacade },
  getConfig: () => ForgeConfig,
  workspaceRoot: string,
): AgentMesh {
  const paths = busPaths();
  const exchangePaths: ExchangeLogPaths = {
    log: path.join(paths.root, EXCHANGES_LOG_NAME),
    lock: path.join(paths.root, EXCHANGES_LOCK_NAME),
  };

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
  const exchangeScope = new Map<string, { workspace: string; conversation?: string }>();

  const onEvent: (e: {
    exchangeId: string;
    from: string;
    to?: string;
    type: string;
    state: ExchangeState;
    detail?: string;
  }) => void = (e) => {
    const s = exchangeScope.get(e.exchangeId) ?? scope();
    if (!exchangeScope.has(e.exchangeId)) exchangeScope.set(e.exchangeId, s);
    void appendEvent(
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
    ).catch((err) =>
      vscode.window.showErrorMessage(`[agent mesh] could not write a board event: ${String(err)}`),
    );
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
      const s = scope();
      void appendEvent(
        exchangePaths,
        {
          eventId: `context-lost-${alias}-${Date.now()}`,
          ts: Date.now(),
          exchangeId: `context-lost-${alias}`,
          workspace: s.workspace,
          ...(s.conversation ? { conversation: s.conversation } : {}),
          from: 'forge',
          to: alias,
          type: 'notice',
          state: 'context_lost',
          detail: `thread resume failed: ${reason}`,
        },
        {},
      ).catch(() => undefined);
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

  const orchestrator = new MeshOrchestrator({
    busRoot: paths.root,
    provider,
    scope,
    onEvent,
    knownAliases,
  });
  setMeshOrchestrator(orchestrator);

  // Startup recovery (M2/M3): reap a dead owner host's session (keeping its
  // thread_id for resume) and write a `crashed` board event (idempotent by
  // event id). No notice is sent during a crash — this is the recovery pass.
  void (async () => {
    try {
      const recovery = recoverOwnership(paths.root);
      for (const action of recovery.actions) {
        if (action.action !== 'reaped') continue;
        await provider.reap(action.alias);
        const s = scope();
        await appendEvent(
          exchangePaths,
          {
            eventId: `crash-${action.alias}`,
            ts: Date.now(),
            exchangeId: `crash-${action.alias}`,
            workspace: s.workspace,
            ...(s.conversation ? { conversation: s.conversation } : {}),
            from: 'forge',
            to: action.alias,
            type: 'notice',
            state: 'crashed',
            detail: 'owned session lost; thread kept for resume',
          },
          {},
        );
      }
    } catch {
      // Recovery is best-effort; a failure here must not block activation.
    }
  })();

  const relay: AgentMesh['relay'] = async (from, to, text) => {
    const result = await orchestrator.relay(from, to, text);
    if ('error' in result) return { ok: false, error: result.error };
    return { ok: true, exchangeId: result.exchangeId };
  };

  const validateFrom: AgentMesh['validateFrom'] = (from) => orchestrator.validateFrom(from);

  const dispose = async (): Promise<void> => {
    orchestrator.dispose();
    await provider.dispose();
    setMeshOrchestrator(undefined);
  };
  context.subscriptions.push({ dispose: () => void dispose() });

  return { orchestrator, provider, relay, validateFrom, dispose };
}
