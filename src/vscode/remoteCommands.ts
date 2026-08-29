import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { RemoteRuntime } from '../remote/RemoteRuntime';
import { TELEGRAM_BOT_TOKEN_SECRET } from '../remote/TelegramChannel';

export function registerRemoteCommands(
  context: vscode.ExtensionContext,
  runtime: RemoteRuntime,
  getConfig: () => ForgeConfig,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.remote.configure', async () => {
      const active = runtime.activeTransports();
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Set Telegram bot token', command: 'forge.remote.setTelegramToken' },
          { label: 'Validate remote control', command: 'forge.remote.validate' },
          { label: 'Pair Telegram owner', command: 'forge.remote.pairTelegram' },
          { label: 'Unpair Telegram owner', command: 'forge.remote.unpairTelegram' },
          { label: 'Link WhatsApp device', command: 'forge.remote.linkWhatsApp' },
          { label: 'Pair WhatsApp owner', command: 'forge.remote.pairWhatsApp' },
          { label: 'Unlink WhatsApp device', command: 'forge.remote.unlinkWhatsApp' },
          { label: 'Open Forge config', command: 'forge.openConfig' },
        ],
        {
          title: `Forge Remote Control — active: ${active.join(', ') || 'none'}`,
          placeHolder: 'Choose a setup action',
        },
      );
      if (pick) await vscode.commands.executeCommand(pick.command);
    }),
    vscode.commands.registerCommand('forge.remote.setTelegramToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Paste the Telegram bot token from BotFather',
        password: true,
        ignoreFocusOut: true,
      });
      if (!token?.trim()) return;
      await context.secrets.store(TELEGRAM_BOT_TOKEN_SECRET, token.trim());
      await runtime.applyConfig(getConfig());
      void vscode.window.showInformationMessage('Forge: Telegram bot token stored securely.');
    }),
    vscode.commands.registerCommand('forge.remote.validate', async () => {
      try {
        const status = await runtime.validationStatus(getConfig());
        const lines = [
          `Remote control: ${status.enabled ? 'enabled' : 'disabled'}`,
          ...status.transports.map(
            (item) =>
              `${item.name}: configured=${item.configured}, active=${item.active}, lease=${item.leaseOwned}, owner=${item.ownerPaired}, provider=${item.providerOk} — ${item.detail}`,
          ),
          `Requests: queued=${status.requests.queued}, running=${status.requests.running}, crash-unknown=${status.requests.unknown}`,
          `Notifications: pending=${status.outbox.pending}, sending=${status.outbox.sending}, abandoned=${status.outbox.abandoned}`,
        ];
        void vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Forge remote validation failed: ${(err as Error).message}`,
        );
      }
    }),
    vscode.commands.registerCommand('forge.remote.pairTelegram', () => {
      try {
        const code = runtime.beginPairing('telegram');
        void vscode.window.showInformationMessage(
          `Forge: send /pair ${code} to your bot in a private Telegram chat within 5 minutes.`,
          { modal: true },
        );
      } catch (err) {
        void vscode.window.showErrorMessage((err as Error).message);
      }
    }),
    vscode.commands.registerCommand('forge.remote.unpairTelegram', async () => {
      await runtime.unpair('telegram');
      void vscode.window.showInformationMessage('Forge: Telegram remote owner unpaired.');
    }),
    vscode.commands.registerCommand('forge.remote.linkWhatsApp', async () => {
      const phone = await vscode.window.showInputBox({
        prompt: 'WhatsApp phone number, digits only, including country code',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
          /^\d{7,15}$/.test(value) ? undefined : 'Enter 7-15 digits with country code.',
      });
      if (!phone) return;
      try {
        await runtime.requestWhatsAppPairingCode(phone);
      } catch (err) {
        void vscode.window.showErrorMessage((err as Error).message);
      }
    }),
    vscode.commands.registerCommand('forge.remote.pairWhatsApp', () => {
      try {
        const code = runtime.beginPairing('whatsapp');
        void vscode.window.showInformationMessage(
          `Forge: send /pair ${code} from your private WhatsApp chat within 5 minutes.`,
          { modal: true },
        );
      } catch (err) {
        void vscode.window.showErrorMessage((err as Error).message);
      }
    }),
    vscode.commands.registerCommand('forge.remote.unlinkWhatsApp', async () => {
      try {
        await runtime.unlinkWhatsApp();
        await runtime.applyConfig(getConfig());
        void vscode.window.showInformationMessage(
          'Forge: WhatsApp device and remote owner were unlinked.',
        );
      } catch (err) {
        void vscode.window.showErrorMessage((err as Error).message);
      }
    }),
  );
}
