import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { loadConfig, findConfigPath } from '../config/ConfigLoader';
import { getLogger } from '../util/logger';
import { enterSetupMode } from '../sidebar/SetupMode';
import type { BackendStatusBar } from './BackendStatusBar';

export interface ConfigBootstrap {
  config: ForgeConfig;
  configPath: string;
}

/**
 * Find and load the config on first activation, with the setup-mode fallback.
 * Returns undefined when activation must stop (no config found, or a broken
 * global fallback config) — the caller returns early. Distinct from
 * configReload.ts, which owns the *reload* path, not the first load.
 */
export function bootstrapConfig(
  context: vscode.ExtensionContext,
  statusBar: BackendStatusBar,
  storagePath: string,
): ConfigBootstrap | undefined {
  const log = getLogger();
  const explicitConfig = vscode.workspace.getConfiguration('forge').get<string>('configFile');
  const configPath = findConfigPath(storagePath, explicitConfig);

  if (!configPath) {
    enterSetupMode(
      context,
      statusBar,
      'Forge: No config found. Run the setup wizard to get started.',
    );
    return undefined;
  }

  let config: ForgeConfig;
  try {
    config = loadConfig(path.dirname(configPath));
  } catch (err) {
    const msg = (err as Error).message;
    log.error(msg);
    // A broken global fallback config must not brick every workspace. Surface
    // the reason, then drop into setup mode rather than aborting activation.
    // For an explicit/workspace config the user is actively editing, surface a
    // hard error instead so the mistake is not masked.
    const isGlobalFallback = configPath.startsWith(storagePath);
    if (isGlobalFallback) {
      enterSetupMode(
        context,
        statusBar,
        `Forge: global config failed to load — ${msg}. Run setup or fix ${configPath}.`,
      );
    } else {
      void vscode.window.showErrorMessage(msg);
    }
    return undefined;
  }

  if (config.log_level) log.setLevel(config.log_level);
  return { config, configPath };
}
