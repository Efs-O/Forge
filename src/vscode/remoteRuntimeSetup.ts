import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { loadConfig } from '../config/ConfigLoader';
import { updateConfigFile } from '../config/ConfigWriter';
import { RemoteRuntime } from '../remote/RemoteRuntime';
import { TelegramChannel, TELEGRAM_BOT_TOKEN_SECRET } from '../remote/TelegramChannel';
import { registerRemoteCommands } from './remoteCommands';
import { startWakeRelay } from './wakeRelaySetup';
import { disposeLocalLlamaFetch } from '../llm/localLlamaFetch';
import type { JobStore } from '../jobs/JobStore';
import type { SidebarProvider } from '../sidebar/SidebarProvider';

/**
 * Build and start the remote runtime: the channel factories (Telegram from
 * SecretStorage, WhatsApp lazy-imported), the config setters, the wake relay,
 * the initial applyConfig, and the remote command registrations. Returns the
 * runtime so the caller (activate) can assign the module-level
 * `activeRemoteRuntime` (deactivate reads it) and wire `onReloaded`.
 *
 * The config setters reassign the outer `let config` through `setConfig` (the
 * same pattern `registerNativeCommands` uses) and apply the reloaded config to
 * the local runtime reference. `publishRemoteStatus` is referenced by
 * `onStatusChanged` before its `const` line, matching the original order: the
 * callback is only invoked later, once the `const` is initialized.
 */
export async function setupRemoteRuntime(
  context: vscode.ExtensionContext,
  deps: {
    workspaceRoot: string;
    workspaceId: string;
    configPath: string;
    getConfig: () => ForgeConfig;
    setConfig: (next: ForgeConfig) => void;
    sidebarProvider: SidebarProvider;
    jobStore: JobStore;
  },
): Promise<RemoteRuntime> {
  const { workspaceRoot, workspaceId, configPath, sidebarProvider, jobStore } = deps;

  const remoteRuntime = new RemoteRuntime({
    storageDirectory: context.globalStorageUri.fsPath,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    workspaceId,
    configPath,
    host: sidebarProvider.getHostFacade(),
    secrets: context.secrets,
    // Shared job store (B3): /jobs and /job edit the same files the scheduler and manage_jobs use.
    jobStore,
    channelFactories: {
      telegram: async (cursor) => {
        const token = await context.secrets.get(TELEGRAM_BOT_TOKEN_SECRET);
        if (!token) {
          throw new Error(
            'Telegram is enabled but no bot token is stored. Run “Forge: Set Telegram Bot Token”.',
          );
        }
        return new TelegramChannel({
          token,
          ...cursor,
          onError: (message) => void vscode.window.showErrorMessage(message),
        });
      },
      whatsapp: async () => {
        const [{ BaileysWhatsAppChannel }, { WhatsAppAuthStore }] = await Promise.all([
          import('../remote/whatsapp/BaileysWhatsAppChannel'),
          import('../remote/whatsapp/WhatsAppAuthStore'),
        ]);
        return new BaileysWhatsAppChannel({
          authStore: new WhatsAppAuthStore(
            path.join(context.globalStorageUri.fsPath, 'whatsapp-auth-v1.enc.json'),
            context.secrets,
          ),
          onError: (message) => void vscode.window.showErrorMessage(message),
          onPairingCode: (code) =>
            void vscode.window.showInformationMessage(
              `Forge WhatsApp pairing code: ${code}. Enter it in WhatsApp Linked Devices.`,
              { modal: true },
            ),
        });
      },
    },
    notifyLocal: (message) => void vscode.window.showErrorMessage(message),
    setInactivityTimeout: async (minutes) => {
      updateConfigFile(configPath, (doc) => {
        doc.setIn(['remote', 'auth', 'inactivity_timeout_minutes'], minutes);
      });
      const next = loadConfig(path.dirname(configPath));
      deps.setConfig(next);
      await remoteRuntime.applyConfig(next);
    },
    setRateLimit: async (perMinute) => {
      updateConfigFile(configPath, (doc) => {
        doc.setIn(['remote', 'rate_limit_per_minute'], perMinute);
      });
      const next = loadConfig(path.dirname(configPath));
      deps.setConfig(next);
      await remoteRuntime.applyConfig(next);
    },
    reloadWindow: async () => {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
    openWorkspace: async (directory) => {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(directory), false);
    },
    confirmWhisperServerStart: async (detail) =>
      (await vscode.window.showWarningMessage(detail, { modal: true }, 'Start Whisper server')) ===
      'Start Whisper server',
    onStatusChanged: () => void publishRemoteStatus(),
  });

  sidebarProvider.remoteEvictionQuery = (conversationId) =>
    remoteRuntime.blocksConversationEviction(conversationId);
  sidebarProvider.tellDrain.registerSource('remote', (id) => remoteRuntime.claimMidTurnTell(id));
  await startWakeRelay(context, deps.getConfig(), sidebarProvider.getHostFacade());
  const publishRemoteStatus = async (): Promise<void> => {
    sidebarProvider.setRemoteStatus(await remoteRuntime.status());
  };
  await remoteRuntime.applyConfig(deps.getConfig()).catch((err) => {
    void vscode.window.showErrorMessage(`Forge remote failed to start: ${(err as Error).message}`);
  });
  await publishRemoteStatus();
  context.subscriptions.push({ dispose: () => void sidebarProvider.dispose() });
  context.subscriptions.push({ dispose: () => void remoteRuntime.dispose() });
  context.subscriptions.push({ dispose: () => void disposeLocalLlamaFetch() });
  registerRemoteCommands(context, remoteRuntime, deps.getConfig, configPath);
  return remoteRuntime;
}
