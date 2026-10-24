import type { ForgeConfig } from '../config/types';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteHandoffCoordinator } from './RemoteHandoffCoordinator';
import { currentWorkspaceIdentity, workspaceAliases } from './remoteControllerOptions';
import { recordWorkspaceHandoff } from './RemoteWorkspaceHandoff';

export interface RemoteWorkspaceSwitchDeps {
  config: ForgeConfig;
  alias: string;
  channel: string;
  chatId: string;
  workspaceId: string;
  workspaceRoot?: string;
  store: RemoteRequestStore;
  coordinator: RemoteHandoffCoordinator;
  stopTransports: () => Promise<void>;
  openWorkspace: (directory: string) => Promise<void>;
}

/** Persists the handoff now, then returns the move to run after inbound disposition. */
export async function prepareRemoteWorkspaceSwitch(
  deps: RemoteWorkspaceSwitchDeps,
): Promise<() => Promise<void>> {
  const aliases = workspaceAliases(deps.config, deps.workspaceRoot);
  const target = aliases[deps.alias];
  if (!target) throw new Error(`workspace “${deps.alias}” was not found.`);
  const handoffId = await recordWorkspaceHandoff(
    deps.store,
    deps.workspaceId,
    target,
    deps.alias,
    deps.channel,
    deps.chatId,
  );
  const rollback = {
    handoffId,
    channel: deps.channel as 'telegram' | 'whatsapp',
    chatId: deps.chatId,
    targetName: target.display_name,
    currentName:
      currentWorkspaceIdentity(aliases, deps.workspaceId, deps.workspaceRoot).name ??
      'this workspace',
  };
  return async () => {
    // openWorkspace kills this window: nothing may still hold the state lock.
    await deps.store.drainMutations();
    await deps.stopTransports();
    await deps.store.drainMutations();
    // The target window's claim handles a reload; otherwise this timer does.
    deps.coordinator.armRollback(rollback);
    try {
      await deps.openWorkspace(target.path);
    } catch (err) {
      await deps.coordinator.rollbackNow(rollback);
      throw err;
    }
  };
}
