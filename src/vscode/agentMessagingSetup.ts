import * as vscode from 'vscode';
import { busPaths } from '../agentBus/agentBus';
import { AgentInbox } from '../agentBus/agentInbox';
import { AgentRoutes } from '../backend/agentRoutes';
import type { ForgeConfig } from '../config/types';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { parseMeshCommand } from '../agentMesh/meshCommands';
import { setupAgentMesh } from './agentMeshSetup';

/**
 * Agent messaging, inbound (docs/plans/AGENT_MESSAGING_PLAN.md): the
 * `/agent/*` routes the control server mounts, and the inbox that turns each
 * message into a visible turn in the active chat, one at a time.
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
  getSidebar: () => { getHostFacade(): ForgeHostFacade },
  getConfig: () => ForgeConfig,
  workspaceRoot: string,
): AgentRoutes {
  const mesh = setupAgentMesh(context, getSidebar, getConfig, workspaceRoot);
  const inbox = new AgentInbox({
    isBusy: () => {
      const status = getSidebar().getHostFacade().status();
      return status.streamingConversationIds.includes(status.activeConversationId);
    },
    submit: async (prompt) => {
      const facade = getSidebar().getHostFacade();
      await vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
      await facade.send(facade.status().activeConversationId, prompt);
    },
    warn: (message) => void vscode.window.showWarningMessage(message),
    // §9 (P1): a bus-started turn just ended. The sender gets one `finished`
    // line via tell (which writes the board event), so there are no silent
    // stalls. A user-typed turn has no bus sender, so this never fires for it.
    onBusTurnFinished: (from, durationMs) => {
      const minutes = Math.max(1, Math.round(durationMs / 60_000));
      void mesh.orchestrator
        .tell(from, `finished · ${minutes} min · the turn you started has ended`)
        .catch((err) =>
          vscode.window.showWarningMessage(`[agent mesh] finished notice failed: ${String(err)}`),
        );
    },
  });
  context.subscriptions.push(inbox);
  return new AgentRoutes({
    paths: () => busPaths(),
    inbox,
    relay: mesh.relay,
    validateFrom: mesh.validateFrom,
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
}
