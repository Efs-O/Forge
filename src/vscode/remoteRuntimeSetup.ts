import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { loadConfig } from '../config/ConfigLoader';
import { updateForgeKeyFile } from '../config/ConfigWriter';
import { RemoteRuntime } from '../remote/RemoteRuntime';
import { TelegramChannel, TELEGRAM_BOT_TOKEN_SECRET } from '../remote/TelegramChannel';
import { registerRemoteCommands } from './remoteCommands';
import { thisWindowHostedElsewhere } from './remoteWindowKind';
import { startWakeRelay } from './wakeRelaySetup';
import { disposeLocalLlamaFetch } from '../llm/localLlamaFetch';
import type { JobStore } from '../jobs/JobStore';
import type { SidebarProvider } from '../sidebar/SidebarProvider';
import { getLogger } from '../util/logger';

const log = getLogger();

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
    isModelLoaded: (modelName: string) => boolean;
    getConfig: () => ForgeConfig;
    setConfig: (next: ForgeConfig) => void;
    sidebarProvider: SidebarProvider;
    jobStore: JobStore;
  },
): Promise<RemoteRuntime> {
  const { workspaceRoot, workspaceId, configPath, isModelLoaded, sidebarProvider, jobStore } = deps;

  // A VS Code tunnel or SSH window runs this extension host ON the desktop, but
  // its SecretStorage is the machine being typed on, which by owner rule holds
  // no bot token. The desktop's own, non-remote Forge window is the transport
  // host (LAPTOP_HEAD_PLAN.md D2), so a transport started here would only
  // collide with it — a Telegram 409, and a wake-relay port clash. A WSL,
  // container or Codespaces window is not that case: it is this computer's own,
  // or a VM with no second Forge window in it, so `remoteWindowKind.ts` counts
  // it as local and the transports still run here.
  // The reason is logged once and handed to the runtime, so every remote command
  // that would have started or paired a transport says it too.
  const hostedElsewhere = thisWindowHostedElsewhere()
    ? "Telegram, WhatsApp and the wake relay run in the desktop's own Forge window, " +
      'not in this VS Code Remote window.'
    : undefined;
  if (hostedElsewhere) log.info(hostedElsewhere);

  const remoteRuntime = new RemoteRuntime({
    storageDirectory: context.globalStorageUri.fsPath,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    workspaceId,
    configPath,
    isModelLoaded,
    ...(hostedElsewhere ? { hostedElsewhere } : {}),
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
      updateForgeKeyFile(configPath, 'remote', (doc) => {
        doc.setIn(['remote', 'auth', 'inactivity_timeout_minutes'], minutes);
      });
      const next = loadConfig(path.dirname(configPath));
      deps.setConfig(next);
      await remoteRuntime.applyConfig(next);
    },
    setRateLimit: async (perMinute) => {
      updateForgeKeyFile(configPath, 'remote', (doc) => {
        doc.setIn(['remote', 'rate_limit_per_minute'], perMinute);
      });
      const next = loadConfig(path.dirname(configPath));
      deps.setConfig(next);
      await remoteRuntime.applyConfig(next);
    },
    reloadWindow: async () => {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
    openWorkspace: async (directory, forceNewWindow) => {
      // `forceNewWindow` is what makes `new-window` a second window instead of
      // focusing the one that already has this folder open — and that distinction
      // is the whole feature: focusing an existing window means nothing reloads,
      // so nothing runs the claim, and the chat goes silent after "switching…".
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(directory),
        forceNewWindow,
      );
    },
    // Read live rather than captured: the owner can change `forge.configFile`
    // without reloading, and a switch must ask what the target will load today.
    userConfigFileSetting: () =>
      vscode.workspace.getConfiguration('forge').get<string>('configFile') ?? undefined,
    confirmWhisperServerStart: async (detail) =>
      (await vscode.window.showWarningMessage(detail, { modal: true }, 'Start Whisper server')) ===
      'Start Whisper server',
    onStatusChanged: () => void publishRemoteStatus(),
  });

  sidebarProvider.remoteEvictionQuery = (conversationId) =>
    remoteRuntime.blocksConversationEviction(conversationId);
  // The sessions panel's phone badge reads the same binding list the eviction
  // gate does, only for the channel instead of for "is this chat pinned". No
  // new state: the binding is created when the first inbound prompt makes the
  // chat, and this is a read of it. An unloaded store answers `undefined`, and
  // a channel the panel does not know (`fake`, anything unknown) badges nothing.
  sidebarProvider.remoteOriginQuery = (conversationId) =>
    remoteRuntime.conversationOriginChannel(conversationId);
  sidebarProvider.tellDrain.registerSource('remote', (id) => remoteRuntime.claimMidTurnTell(id));
  await startWakeRelay(context, deps.getConfig(), sidebarProvider.getHostFacade());
  const publishRemoteStatus = async (): Promise<void> => {
    sidebarProvider.setRemoteStatus(await remoteRuntime.status());
  };
  await remoteRuntime.applyConfig(deps.getConfig()).catch((err) => {
    const message = (err as Error).message;
    log.error(`[remote] start failed: ${message}`);
    void vscode.window.showErrorMessage(`Forge remote failed to start: ${message}`);
  });
  await publishRemoteStatus();
  context.subscriptions.push({ dispose: () => void sidebarProvider.dispose() });
  context.subscriptions.push({ dispose: () => void remoteRuntime.dispose() });
  context.subscriptions.push({ dispose: () => void disposeLocalLlamaFetch() });
  registerRemoteCommands(context, remoteRuntime, deps.getConfig, configPath);
  return remoteRuntime;
}
