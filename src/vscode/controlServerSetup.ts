import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { ControlServer } from '../backend/ControlServer';
import { ControlServerRegistry, controlServerRegistryPath } from '../backend/ControlServerRegistry';
import type { BackendPool } from '../backend/BackendPool';
import { buildControlChatProxy } from '../llm/ControlChatProxy';
import type { SidebarProvider } from '../sidebar/SidebarProvider';
import type { RemoteRuntime } from '../remote/RemoteRuntime';
import { registerControlServerCommands } from './controlCommands';
import { setupAgentMessaging } from './agentMessagingSetup';

/** What wiring the control API gives back to `activate()`: the server itself,
 *  and the agent-bus task that must wait until this window has a sidebar. */
export interface ControlServerWiring {
  controlServer: ControlServer;
  /** Recover the pending agent replies this window crashed before answering.
   *  `src/extension.ts` calls it once, right after the sidebar provider is
   *  assigned — recovery reads the window's chat list, and setup runs long
   *  before that provider exists. */
  recoverPendingReplies(): Promise<void>;
}

/** Construct and register the loopback-only :8799 control API. */
export function wireControlServer(options: {
  context: vscode.ExtensionContext;
  pool: BackendPool;
  getConfig: () => ForgeConfig;
  workspaceRoot: string;
  getSidebarProvider: () => SidebarProvider;
  getRemoteRuntime: () => RemoteRuntime | undefined;
}): ControlServerWiring {
  const registryPath = controlServerRegistryPath();
  const registry = registryPath ? new ControlServerRegistry(registryPath) : undefined;
  const packageVersion = options.context.extension.packageJSON['version'];
  const agentMessaging = setupAgentMessaging(
    options.context,
    options.getSidebarProvider,
    options.getConfig,
    options.workspaceRoot,
    options.getRemoteRuntime,
  );
  const controlServer = new ControlServer(options.pool, options.getConfig(), {
    agentRoutes: agentMessaging.routes,
    chatProxy: buildControlChatProxy(options.getConfig, options.context.secrets),
    ...(registry ? { registry } : {}),
    version: typeof packageVersion === 'string' ? packageVersion : 'unknown',
  });
  if (options.getConfig().control_server?.enabled) controlServer.start();
  options.context.subscriptions.push(controlServer);
  registerControlServerCommands(options.context, controlServer);
  return { controlServer, recoverPendingReplies: agentMessaging.recoverPendingReplies };
}
