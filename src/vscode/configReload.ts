/**
 * Hot-reloading config.yaml.
 *
 * Split out of `extension.ts`. The one rule that is easy to lose here: the
 * user's active model selection — including any `@profile` — must survive a
 * reload whenever its base model still exists in the new config, or editing an
 * unrelated setting silently switches the model mid-conversation.
 */

import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { watchForgeConfigPaths } from '../config/ConfigLoader';
import { expandAlias, splitModelProfile } from '../config/ConfigResolver';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface ConfigReloadOptions {
  configPath: string;
  getConfig: () => ForgeConfig;
  /** Applies the reloaded config across the extension. */
  onReloaded: (next: ForgeConfig) => void;
}

export function watchForgeConfig(options: ConfigReloadOptions): vscode.Disposable {
  return watchForgeConfigPaths(options.configPath, [], (newConfig, err) => {
    if (err) {
      void vscode.window.showErrorMessage(`Forge: config reload failed — ${err.message}`);
      return;
    }
    if (!newConfig) return;

    const prevActive = options.getConfig().active_model;
    // Preserve the previous selection (incl. any @profile) across reloads if
    // its base model still exists in the new config (F6).
    const prevBase = prevActive ? splitModelProfile(expandAlias(newConfig, prevActive)).base : null;
    if (prevActive && prevBase && newConfig.models.some((m) => m.name === prevBase)) {
      newConfig.active_model = prevActive;
    }

    options.onReloaded(newConfig);
    log.info('Forge: config reloaded');
    void vscode.window.showInformationMessage(
      'Forge: configuration reloaded (restart backend if you changed llama-server spawn settings)',
    );
  });
}
