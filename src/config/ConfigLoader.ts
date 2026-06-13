import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import { ForgeConfigSchema } from './schema';
import type { ForgeConfig } from './types';
import { splitModelProfile } from './ConfigResolver';

const CONFIG_FILENAME = 'config.yaml';

export function loadConfig(storagePath: string): ForgeConfig {
  const filePath = path.join(storagePath, CONFIG_FILENAME);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Forge: config.yaml not found at ${filePath}.\n` +
      `Create .forge/config.yaml in your workspace or use the setup wizard to generate one.`,
    );
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = (yaml.load(raw) ?? {}) as Record<string, unknown>;

  const result = ForgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Forge: config.yaml validation failed:\n${issues}`);
  }

  const config = result.data as ForgeConfig;
  const seen = new Set<string>();
  for (const model of config.models) {
    if (seen.has(model.name)) {
      throw new Error(`Forge: duplicate model name "${model.name}" in config.yaml`);
    }
    seen.add(model.name);
  }
  const modelNames = new Set(config.models.map((m) => m.name));
  const profileNames = new Set(Object.keys(config.profiles ?? {}));

  // active_model may carry a trailing @profile (F6). Aliases are resolved at use
  // time, so an active_model that is an alias key is valid too.
  if (config.active_model) {
    const { base, profile } = splitModelProfile(config.active_model);
    const isAlias = Boolean(config.aliases?.[base]);
    if (!isAlias && !modelNames.has(base)) {
      throw new Error(
        `Forge: active_model "${config.active_model}" does not match any configured model (${config.models.map((m) => m.name).join(', ')})`,
      );
    }
    if (!isAlias && profile && !profileNames.has(profile)) {
      throw new Error(
        `Forge: active_model "${config.active_model}" references unknown profile "${profile}" (available: ${[...profileNames].join(', ') || 'none'})`,
      );
    }
  }

  // Every alias target must resolve to a known base (+ known profile if present).
  for (const [key, target] of Object.entries(config.aliases ?? {})) {
    const { base, profile } = splitModelProfile(target);
    if (!modelNames.has(base)) {
      throw new Error(`Forge: alias "${key}" → "${target}" targets unknown model "${base}"`);
    }
    if (profile && !profileNames.has(profile)) {
      throw new Error(`Forge: alias "${key}" → "${target}" references unknown profile "${profile}"`);
    }
  }

  config.models = config.models.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return config;
}

/**
 * Resolve explicit path from user settings: absolute path to config.yaml, or to a directory that contains it.
 * Returns null if empty, missing, or invalid.
 */
export function resolveExplicitConfigPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = path.normalize(trimmed);
  if (!fs.existsSync(normalized)) return null;
  const stat = fs.statSync(normalized);
  if (stat.isFile()) {
    return path.basename(normalized).toLowerCase() === CONFIG_FILENAME.toLowerCase() ? normalized : null;
  }
  if (stat.isDirectory()) {
    const candidate = path.join(normalized, CONFIG_FILENAME);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Find config.yaml: optional absolute override (settings), then workspace .forge/, then global storage.
 * Returns the path if found, null otherwise.
 */
export function findConfigPath(globalStoragePath: string, explicitConfigPathSetting?: string | null): string | null {
  const fromSetting = explicitConfigPathSetting ? resolveExplicitConfigPath(explicitConfigPathSetting) : null;
  if (fromSetting) return fromSetting;

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
 * Watch workspace `config.yaml` and optional extra absolute paths.
 * Debounces so saves that touch multiple files produce one reload.
 */
export function watchForgeConfigPaths(
  primaryConfigYamlPath: string,
  extraAbsolutePaths: string[],
  onReload: (config: ForgeConfig | null, error?: Error) => void,
): vscode.Disposable {
  const forgeDir = path.dirname(primaryConfigYamlPath);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const reload = (): void => {
    try {
      const loaded = loadConfig(forgeDir);
      onReload(loaded);
    } catch (err) {
      onReload(null, err instanceof Error ? err : new Error(String(err)));
    }
  };

  const schedule = (): void => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      reload();
    }, 150);
  };

  const normalizedSeen = new Set<string>();
  const watchers: vscode.Disposable[] = [];

  const watchOne = (absPath: string): void => {
    const normalized = path.normalize(absPath);
    if (normalizedSeen.has(normalized)) return;
    normalizedSeen.add(normalized);

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(normalized), path.basename(normalized)),
    );
    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
    watchers.push(watcher);
  };

  watchOne(primaryConfigYamlPath);
  for (const p of extraAbsolutePaths) watchOne(p);

  watchers.push(
    new vscode.Disposable(() => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    }),
  );

  return vscode.Disposable.from(...watchers);
}
