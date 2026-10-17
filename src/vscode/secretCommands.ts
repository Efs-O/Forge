import * as fs from 'fs';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';

export function registerSecretCommands(
  context: vscode.ExtensionContext,
  getConfig: () => ForgeConfig,
  configPath: string,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.setSearchApiKey', async () => {
      const config = getConfig();
      const options = [
        {
          label: 'Tavily',
          description: 'tavily.com — recommended',
          value: 'tavily' as const,
        },
        { label: 'Brave Search', description: 'brave.com/search/api', value: 'brave' as const },
      ];
      const pick = await vscode.window.showQuickPick(options, {
        title: 'Forge: Select Search Provider',
        placeHolder: 'Select the provider whose API key to store',
      });
      if (!pick) return;
      const provider = pick.value;
      const secretKeyName =
        provider === config.search?.provider && config.search.secret_key_name
          ? config.search.secret_key_name
          : `forge.${provider}.apiKey`;
      if (!config.search) {
        try {
          const existing = fs.readFileSync(configPath, 'utf8');
          const block = `\nsearch:\n  provider: ${provider}\n  secret_key_name: ${secretKeyName}\n  max_results: 5\n`;
          if (!/^search:/m.test(existing)) fs.appendFileSync(configPath, block, 'utf8');
        } catch {
          void vscode.window.showWarningMessage(
            'Forge: could not update config.yaml — add the search block manually.',
          );
        }
      }
      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${provider} API key`,
        password: true,
        ignoreFocusOut: true,
      });
      if (key) await context.secrets.store(secretKeyName, key);
    }),
    vscode.commands.registerCommand('forge.setCloudToken', async () => {
      const secretKey = await vscode.window.showInputBox({
        prompt: 'Secret key name matching api_key_secret in config.yaml',
        placeHolder: 'openai',
        ignoreFocusOut: true,
      });
      if (!secretKey?.trim()) return;
      const token = await vscode.window.showInputBox({
        prompt: `Paste bearer token for "${secretKey.trim()}"`,
        password: true,
        ignoreFocusOut: true,
      });
      if (token?.trim()) await context.secrets.store(secretKey.trim(), token.trim());
    }),
  );
}
