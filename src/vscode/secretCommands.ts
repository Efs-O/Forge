import * as vscode from 'vscode';
import { updateForgeKeyFile } from '../config/ConfigWriter';
import type { ForgeWriteOptions } from '../config/ConfigWriter';
import type { ForgeConfig } from '../config/types';
import { secretKeyNameFor } from '../tools/searchTool';

/**
 * Add the `search:` block the key the command is about to store belongs to.
 *
 * `search` is a policy key (`policySchema.ts`), so the block cannot simply be
 * appended to `config.yaml`: once `~/.forge/policy.yaml` exists the loader
 * refuses a config file that holds one (`assertConfigFileKeys`), and the command
 * would break the config it was completing. `updateForgeKeyFile` picks the file
 * that owns the key today (policy.yaml once it exists, config.yaml before the
 * owner migrates), preserves comments, validates the pair and writes atomically.
 * An existing block is left alone — the command stores a key for a provider the
 * owner may already have configured as a `fallback`.
 */
export function addSearchBlock(
  configPath: string,
  provider: 'tavily',
  secretKeyName: string,
  options: ForgeWriteOptions = {},
): void {
  updateForgeKeyFile(
    configPath,
    'search',
    (doc) => {
      if (doc.has('search')) return;
      doc.set('search', { provider, secret_key_name: secretKeyName, max_results: 5 });
    },
    options,
  );
}

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
      ];
      const pick = await vscode.window.showQuickPick(options, {
        title: 'Forge: Select Search Provider',
        placeHolder: 'Select the provider whose API key to store',
      });
      if (!pick) return;
      const provider = pick.value;
      const secretKeyName = secretKeyNameFor(provider, config.search);
      if (!config.search) {
        try {
          addSearchBlock(configPath, provider, secretKeyName);
        } catch (err) {
          // No block, so no point storing a key nothing names: stop here rather
          // than ask the user for a key that would never be read.
          void vscode.window.showErrorMessage(
            `Forge: could not add the search block: ${(err as Error).message}`,
          );
          return;
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
