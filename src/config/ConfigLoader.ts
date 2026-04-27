import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import { ForgeConfigSchema } from './schema';
import type { ForgeConfig } from './types';

const CONFIG_FILENAME = 'config.yaml';

export function loadConfig(storagePath: string): ForgeConfig {
  const filePath = path.join(storagePath, CONFIG_FILENAME);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Forge: config.yaml not found at ${filePath}.\n` +
      `Copy config/config.example.yaml to that location and edit it.`,
    );
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw);

  const result = ForgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Forge: config.yaml validation failed:\n${issues}`);
  }

  return result.data as ForgeConfig;
}

/**
 * Find config.yaml: check workspace .forge/ first, then global storage.
 * Returns the path if found, null otherwise.
 */
export function findConfigPath(globalStoragePath: string): string | null {
  // Check workspace root first
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders?.length) {
    const wsConfig = path.join(workspaceFolders[0].uri.fsPath, '.forge', CONFIG_FILENAME);
    if (fs.existsSync(wsConfig)) return wsConfig;
  }
  // Fall back to global storage
  const globalConfig = path.join(globalStoragePath, CONFIG_FILENAME);
  if (fs.existsSync(globalConfig)) return globalConfig;
  return null;
}

/**
 * Watch config.yaml for changes. Calls callback with new config or error.
 * Returns a disposable to stop watching.
 */
export function watchConfig(
  configPath: string,
  onReload: (config: ForgeConfig | null, error?: Error) => void,
): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(path.dirname(configPath), path.basename(configPath)),
  );

  const reload = () => {
    try {
      const config = loadConfig(path.dirname(configPath));
      onReload(config);
    } catch (err) {
      onReload(null, err as Error);
    }
  };

  watcher.onDidChange(reload);
  watcher.onDidCreate(reload);

  return watcher;
}
