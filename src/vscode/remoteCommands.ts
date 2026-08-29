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
  );
}
