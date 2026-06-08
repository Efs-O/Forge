import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import { ForgeConfigSchema } from './schema';
import type { ForgeConfig } from './types';
import { loadBridgeConfigDocument, loadBridgeModels, resolveBridgeConfigPath } from './BridgeConfigLoader';

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
  const bridgeConfigValue = typeof parsed.bridge_config === 'string' ? parsed.bridge_config : undefined;
  if (bridgeConfigValue) {
    const bridgeConfigPath = resolveBridgeConfigPath(filePath, bridgeConfigValue);
    const bridgeDoc = loadBridgeConfigDocument(bridgeConfigPath);

    if (bridgeDoc.config_version === 2) {
      // v2 schema: binary and server settings are under providers.llama_cpp
      if (parsed.llama_server === undefined) {
        const providers = bridgeDoc.providers as Record<string, unknown> | undefined;
        const llamaCpp = providers?.llama_cpp as Record<string, unknown> | undefined;
        if (llamaCpp) {
          const rtDefs = bridgeDoc.runtime_defaults as Record<string, unknown> | undefined;
          const rtLlamaCpp = rtDefs?.llama_cpp as Record<string, unknown> | undefined;
          parsed.llama_server = {
            binary: llamaCpp.binary,
            host: llamaCpp.host,
            port: llamaCpp.base_port,
            ...(rtLlamaCpp && {
              n_gpu_layers: rtLlamaCpp.n_gpu_layers,
              n_batch: rtLlamaCpp.n_batch,
              type_k: rtLlamaCpp.type_k,
              type_v: rtLlamaCpp.type_v,
              flash_attn_default: rtLlamaCpp.flash_attn,
            }),
          };
        }
      }
      // v2: bridge-level settings live under the bridge: section
      const bridgeSec = bridgeDoc.bridge as Record<string, unknown> | undefined;
      if (parsed.strip_thinking_channels === undefined && bridgeSec?.strip_thinking_channels !== undefined) {
        parsed.strip_thinking_channels = bridgeSec.strip_thinking_channels;
      }
      if (parsed.max_simultaneous_models === undefined && typeof bridgeSec?.max_simultaneous_models === 'number') {
        parsed.max_simultaneous_models = bridgeSec.max_simultaneous_models;
      }
    } else {
      // v1 schema: settings at top level of bridge doc
      if (parsed.llama_server === undefined && bridgeDoc.llama_server !== undefined) {
        parsed.llama_server = bridgeDoc.llama_server;
      }
      if (parsed.strip_thinking_channels === undefined && bridgeDoc.strip_thinking_channels !== undefined) {
        parsed.strip_thinking_channels = bridgeDoc.strip_thinking_channels;
      }
    }

    if (parsed.models === undefined) {
      parsed.models = [];
    }
  }

  const result = ForgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Forge: config.yaml validation failed:\n${issues}`);
  }

  const config = result.data as ForgeConfig;
  const bridgeModels = config.bridge_config
    ? loadBridgeModels(resolveBridgeConfigPath(filePath, config.bridge_config))
    : [];
  const mergedModels = [...config.models, ...bridgeModels];
  if (mergedModels.length === 0) {
    throw new Error('Forge: no models configured after merging config.yaml and bridge.yaml');
  }
  const seen = new Set<string>();
  for (const model of mergedModels) {
    if (seen.has(model.name)) {
      throw new Error(`Forge: duplicate model name "${model.name}" across config.yaml and bridge.yaml`);
    }
    seen.add(model.name);
  }
  if (config.active_model && !mergedModels.some((model) => model.name === config.active_model)) {
    throw new Error(
      `Forge: active_model "${config.active_model}" does not match any entry in merged models (${mergedModels.map((m) => m.name).join(', ')})`,
    );
  }
  config.models = mergedModels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
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
 * Watch workspace `config.yaml` and optional extra absolute paths (e.g. merged `bridge.yaml`).
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
