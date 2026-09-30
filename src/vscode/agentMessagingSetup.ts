import * as vscode from 'vscode';
import { busPaths } from '../agentBus/agentBus';
import {
  AgentInbox,
  busTurnEndLine,
  type BusTurnEnd,
  type InboxMessageOptions,
} from '../agentBus/agentInbox';
import { AgentRoutes } from '../backend/agentRoutes';
import { joinClaude } from '../agentMesh/claudeJoin';
import { joinCodex } from '../agentMesh/codexJoin';
import { availableProfilesFor, expandAlias } from '../config/ConfigResolver';
import type { ForgeConfig } from '../config/types';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { MidTurnTellDrain } from '../agent/MidTurnTellDrain';
import { parseMeshCommand } from '../agentMesh/meshCommands';
import { projectWho } from '../agentMesh/meshWho';
import { readClaudeSessions } from '../agentBus/claudePeer';
import { parseForgeInboundPrompt } from '../agentBus/busContent';
import { setupAgentMesh } from './agentMeshSetup';
import { BUS_TARGET_SCAN, busTargetConversation, senderConversation } from '../agentBus/busTarget';
import { BusTurnWatch } from '../agentBus/busTurnWatch';
import { renderBusStatus, renderBusView } from '../agentBus/busStatusView';
import { MAX_VIEW_COUNT, parseViewCount } from '../remote/RemoteTranscriptView';

/** The conversation a bus message from `from` belongs in. */
function busTarget(facade: ForgeHostFacade, from: string | undefined): string {
  return busTargetConversation(from, facade.status(), (id) =>
    facade.recentExchanges(id, BUS_TARGET_SCAN),
  );
}

/** Every model, each `model@profile` it offers, and every alias key: the ids a bus sender may name. */
export function busModelIds(config: ForgeConfig): string[] {
  return [
    ...config.models.flatMap((model) => [
      model.name,
      ...availableProfilesFor(config, model.name).map((profile) => `${model.name}@${profile}`),
    ]),
    ...Object.keys(config.aliases ?? {}),
  ];
}

/** An explicit new chat becomes visible; follow-ups keep their addressed chat. */

export async function submitBusMessage(
  facade: ForgeHostFacade,
  prompt: string,
  options: InboxMessageOptions | undefined,
): Promise<BusTurnEnd> {
  let conversationId = busTarget(facade, options?.from);
  if (options?.newChat) {
    conversationId = (await facade.createConversation({ activate: true })).id;
  } else if (conversationId !== facade.status().activeConversationId) {
    await facade.restoreConversation(conversationId, { activate: false });
  }
  if (options?.model) await facade.setConversationModel(conversationId, options.model);
  const inbound = parseForgeInboundPrompt(prompt);
  if (inbound) {
    // The agent-bus sender cannot see the user's Telegram chat. Reuse the
    // normal host-activity subscription so the already-addressed conversation
    // is durably mirrored to its bound remote chats before the Forge turn runs.
    facade.emitHostActivity?.({
      conversationId,
      text: `Forge: ${inbound.from} says:\n\n${inbound.text}`,
    });
  }
  const outcome = await facade.send(conversationId, prompt);
  return outcome.kind === 'failed'
    ? { kind: 'failed', error: outcome.error }
    : { kind: outcome.kind };
}

/**
 * Agent messaging, inbound (docs/plans/AGENT_MESSAGING_PLAN.md): the
 * `/agent/*` routes the control server mounts, and the inbox that turns each
 * message into a visible turn, one at a time, in the chat its sender last
 * wrote in (the active one for a first message).
 *
 * It also sets up the agent mesh (AGENT_MESH_PLAN P0): the orchestrator the
 * `tell_live_session` tool and the host-side relay (M6) both use. Creating it
 * here keeps `extension.ts` unchanged in shape — the mesh is an inbound concern,
 * and `setupAgentMesh` registers the orchestrator in the process-wide context
 * holder the tool reads.
 *
 * `getSidebar` is called lazily: activation creates the control server before
 * the sidebar exists. Until it does, the inbox reads the chat as busy and
 * waits. The control server pushes `agent_bus.enabled` into the routes.
 */
export function setupAgentMessaging(
  context: vscode.ExtensionContext,
  getSidebar: () => { getHostFacade(): ForgeHostFacade; readonly tellDrain: MidTurnTellDrain },
  getConfig: () => ForgeConfig,
  workspaceRoot: string,
): AgentRoutes {
  const mesh = setupAgentMesh(context, getSidebar, getConfig, workspaceRoot);
  const watch = new BusTurnWatch();
  const inbox = new AgentInbox({
    isBusy: (options?: InboxMessageOptions) => {
      if (options?.newChat) return false;
      const facade = getSidebar().getHostFacade();
      registerTellSource(); // every queued message asks this first
      return facade.status().streamingConversationIds.includes(busTarget(facade, options?.from));
    },
    submit: async (prompt, options?: InboxMessageOptions) => {
      const facade = getSidebar().getHostFacade();
      watch.attach(facade);
      await vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
      // An alias is resolved here so the chat stores the model id its picker shows.
      const model = options?.model && expandAlias(getConfig(), options.model);
      return submitBusMessage(facade, prompt, model ? { ...options, model } : options);
    },
    warn: (message) => void vscode.window.showWarningMessage(message),
    // F-08: a bus-started turn began — write its durable status file so a
    // crashed turn can be detected at the next window's startup.
    onBusTurnStarted: (turnId) => {
      mesh.markTurnStarted(turnId);
    },
    // F-08: a bus-started turn ended (success OR failure) — clear its status
    // file. The inbox calls this in a `finally`, so a normal finish never
    // leaves a stale "running" record; only a crash does, and the startup
    // sweep detects that.
    onBusTurnStatusCleared: (turnId) => {
      mesh.markTurnFinished(turnId);
    },
    // §9 (P1): a bus-started turn just ended successfully. The sender gets one
    // `finished` line via tell (which writes the board event), so there are no
    // silent stalls. A user-typed turn has no bus sender, so this never fires
    // for it.
    onBusTurnFinished: (from, durationMs, end) => {
      void mesh.orchestrator
        .tell(from, busTurnEndLine(end, durationMs))
        .catch((err) =>
          vscode.window.showWarningMessage(`[agent mesh] finished notice failed: ${String(err)}`),
        );
    },
  });
  context.subscriptions.push(inbox);
  context.subscriptions.push(watch);
  // A chat that is mid-turn reads its waiting bus messages at the next
  // tool-round gap, the way Telegram and typed messages reach it. The sidebar
  // may not exist yet at activation, so the first busy check registers it.
  let tellSourceRegistered = false;
  const registerTellSource = (): void => {
    if (tellSourceRegistered) return;
    getSidebar().tellDrain.registerSource('agent-bus', (conversationId) => {
      const facade = getSidebar().getHostFacade();
      const prompts = inbox.claimMidTurn(conversationId, (options) =>
        busTarget(facade, options?.from),
      );
      return Promise.resolve({
        messages: prompts.map((content) => ({ role: 'user' as const, content, midTurn: true })),
      });
    });
    tellSourceRegistered = true;
  };
  const readTarget = (from: string) => {
    const facade = getSidebar().getHostFacade();
    watch.attach(facade);
    const status = facade.status();
    const id = senderConversation(from, status, (cid) =>
      facade.recentExchanges(cid, BUS_TARGET_SCAN),
    );
    if (id === undefined) {
      return {
        ok: false as const,
        status: 404 as const,
        error: `no chat holds a message from "${from}": send one with forge.sh say first`,
      };
    }
    const conversation = status.conversations.find((item) => item.id === id);
    if (conversation === undefined) {
      return {
        ok: false as const,
        status: 404 as const,
        error: `the chat for "${from}" is no longer open`,
      };
    }
    return { ok: true as const, facade, status, id, conversation };
  };
  const routes = new AgentRoutes({
    paths: () => busPaths(),
    inbox,
    isFocused: () => vscode.window.state.focused,
    configuredModels: () => busModelIds(getConfig()),
    relay: mesh.relay,
    // F-06: a `priority=steer` message interrupts the recipient's active turn.
    steer: mesh.steer,
    // §6: a steer to Forge itself interrupts Forge's running turn. It is the
    // last steer left since Telegram `/steer` was removed (MID_TURN_TELL
    // Phase 4). An idle chat has nothing to interrupt.
    interruptForge: async () => {
      const facade = getSidebar().getHostFacade();
      const status = facade.status();
      if (status.streamingConversationIds.includes(status.activeConversationId)) {
        await facade.interrupt(status.activeConversationId);
      }
    },
    validateFrom: mesh.validateFrom,
    // §10: an interactive Claude/Codex session supersedes a Forge-owned peer.
    join: async (alias, pid, thread) => {
      if (alias === 'claude') return joinClaude(busPaths().root, alias, pid);
      if (alias !== 'codex') return { ok: false, error: `cannot join as "${alias}"` };
      if (!thread || !/^[A-Za-z0-9._-]+$/.test(thread)) {
        return { ok: false, error: 'thread must be a non-empty Codex thread id' };
      }
      if (mesh.orchestrator.isBusy('codex')) {
        return { ok: false, error: 'the owned codex turn is busy; join again when it is idle' };
      }
      if (!(await mesh.provider.releaseForCodexJoin())) {
        return { ok: false, error: 'another Forge window owns the codex session' };
      }
      return joinCodex(busPaths().root, alias, thread);
    },
    // §11: `forge.sh who` — read-only projection of every participant and its
    // state. The host owns the truth: it reads the alias table, ownership
    // records and its own in-memory FIFO, plus the sidebar's streaming state
    // and the inbox depth. The client only formats the returned JSON.
    who: () =>
      projectWho({
        busRoot: busPaths().root,
        knownAliases: () => mesh.orchestrator.aliases(),
        isOwner: (alias) => mesh.provider.isOwner(alias),
        isBusy: (alias) => mesh.orchestrator.isBusy(alias),
        forgeBusy: () => {
          const status = getSidebar().getHostFacade().status();
          return status.streamingConversationIds.includes(status.activeConversationId);
        },
        forgeInboxDepth: () => inbox.pending,
        claudeSessions: () => readClaudeSessions(),
      }),
    status: (from) => {
      const target = readTarget(from);
      if (!target.ok) return target;
      return {
        ok: true,
        text: renderBusStatus({
          conversation: target.conversation,
          streaming: target.status.streamingConversationIds.includes(target.id),
          queuedFromSender: inbox.pendingFrom(from),
          budget: target.facade.contextBudget(target.id),
          turn: watch.snapshot(target.id),
          watchAttached: watch.attached,
          now: Date.now(),
        }),
      };
    },
    view: (from, count) => {
      const target = readTarget(from);
      if (!target.ok) return target;
      const requested = parseViewCount(count);
      if (requested.kind === 'invalid') {
        return { ok: false, status: 400, error: `count must be 1-${MAX_VIEW_COUNT}` };
      }
      return {
        ok: true,
        text: renderBusView(target.facade.recentExchanges(target.id, requested.count), {
          clamped: requested.clamped,
          streaming: target.status.streamingConversationIds.includes(target.id),
        }),
      };
    },
    // §8/P3: a `to: forge` message that parses as a typed lifecycle command is
    // dispatched (standby/wake/close/steer/say/handoff) and the reply returned
    // to the caller's `forge.sh cmd` call. Ordinary text falls through to the inbox.
    handleCommand: async (text) => {
      const cmd = parseMeshCommand(text);
      if (!cmd) return { ok: false as const, error: 'not a recognised mesh command' };
      try {
        const reply = await mesh.orchestrator.handleCommand(cmd);
        return { ok: true as const, reply };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) routes.claim();
    }),
  );
  return routes;
}
