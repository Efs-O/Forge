import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { loadConfig, findConfigPath, resolveExplicitConfigPath } from '../config/ConfigLoader';
import { getLogger } from '../util/logger';
import { noticeStaleBuildOnConfigFailure } from './staleBuild';
import { registerPolicyMigrationRecovery } from './policyMigrationRecovery';
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

  // A `forge.configFile` that resolves to nothing used to be invisible:
  // `resolveExplicitConfigPath` returns null for a missing path, and the window
  // quietly used the workspace config — or setup mode — instead. That is how a
  // setting copied onto the wrong machine sat unused for a whole session: the
  // scope was `application`, so a remote window read it from the machine being
  // typed on rather than the one being worked on. Name the setting, the value
  // and what is used instead. Once per activation: `jobsSetup.ts` repeats the
  // same lookup and stays silent on purpose, so the warning is not doubled.
  if (explicitConfig?.trim() && !resolveExplicitConfigPath(explicitConfig)) {
    const message =
      `Forge: forge.configFile is "${explicitConfig}", which is not a config.yaml ` +
      `or a folder holding one. Using ${configPath ?? 'setup mode'} instead.`;
    log.warn(message);
    void vscode.window.showWarningMessage(message);
  }

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
    // A config that the installed build would accept can still fail here: this
    // window may be running last night's rules because it was never reloaded
    // after an upgrade. Say that before the user goes looking for a config error.
    noticeStaleBuildOnConfigFailure();
    // The message shown below tells the owner to run a command this window has
    // not registered, because activation stops here — so register the one they
    // were just told to run before showing the message. `policyMigrationRecovery.ts`
    // owns why it has to be this window's own config path.
    context.subscriptions.push(registerPolicyMigrationRecovery(configPath));
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
