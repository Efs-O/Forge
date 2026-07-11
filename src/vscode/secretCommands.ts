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
      let provider: string;
      let secretKeyName: string;
      if (config.search) {
        provider = config.search.provider;
        secretKeyName = config.search.secret_key_name;
      } else {
        const pick = await vscode.window.showQuickPick(
          [
            { label: 'Tavily', description: 'tavily.com — recommended', value: 'tavily' },
            { label: 'Brave Search', description: 'brave.com/search/api', value: 'brave' },
          ],
          { title: 'Forge: Select Search Provider', placeHolder: 'Select a search provider' },
        );
        if (!pick) return;
        provider = pick.value;
        secretKeyName = `forge.${provider}.apiKey`;
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
