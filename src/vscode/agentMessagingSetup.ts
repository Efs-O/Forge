import * as vscode from 'vscode';
import { busPaths } from '../agentBus/agentBus';
import { AgentInbox } from '../agentBus/agentInbox';
import { AgentRoutes } from '../backend/agentRoutes';
import type { ForgeConfig } from '../config/types';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
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
  });
  context.subscriptions.push(inbox);
  return new AgentRoutes({
    paths: () => busPaths(),
    inbox,
    relay: mesh.relay,
  });
}
