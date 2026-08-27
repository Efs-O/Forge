import * as fs from 'fs';
import * as path from 'path';
import type { ForgeConfig } from '../../config/types';
import { expandAlias, splitModelProfile } from '../../config/ConfigResolver';
import { detectFamily } from '../../backend/ModelHeuristics';
import { extractQuant, scanForGgufs } from '../../backend/GgufScanner';
import { readForgeState } from './usageTracker';
import { overrideKeysOf, resolveModelForDisplay } from './resolvedView';
import type { ModelManagerModelView, ModelManagerStateMsg, OrphanGguf } from './messages';

/**
 * Assembles the full Model Manager state pushed to the webview on open and on
 * every config.yaml reload (F7/§2.3 "stateless view" contract). Single owner
 * for the state shape — the panel never derives any of this itself.
 * See docs/OWNERS.md.
 */

function statSizeSafe(target: string | undefined): number | null {
  if (!target) return null;
  try {
    return fs.statSync(target).size;
  } catch {
    return null;
  }
}

function fileMissing(target: string | undefined): boolean {
  if (!target) return false;
  return !fs.existsSync(target);
}

function activeBaseName(config: ForgeConfig): string | null {
  if (!config.active_model) return null;
  return splitModelProfile(expandAlias(config, config.active_model)).base;
}

async function buildModelView(
  config: ForgeConfig,
  configPath: string,
  isLoaded: (name: string) => boolean,
  activeBase: string | null,
): Promise<ModelManagerModelView[]> {
  const state = readForgeState(configPath);
  return config.models.map((raw) => {
    const resolved = resolveModelForDisplay(config, raw);
    const ggufSize = statSizeSafe(raw.gguf_path);
    const mmprojSize = statSizeSafe(raw.mmproj_path);
    const sizeBytes = raw.gguf_path ? (ggufSize ?? 0) + (mmprojSize ?? 0) : null;
    const basename = raw.gguf_path ? path.basename(raw.gguf_path) : undefined;
    const quant = basename ? extractQuant(basename) : undefined;
    const family = basename ? detectFamily(basename) : undefined;
    return {
      name: raw.name,
      raw,
      resolved,
      overrideKeys: overrideKeysOf(raw),
      provider: resolved.provider ?? 'llama.cpp',
      sizeBytes,
      ...(quant !== undefined ? { quant } : {}),
      ...(family !== undefined ? { family } : {}),
      lastUsed: state.last_used[raw.name] ?? null,
      fileMissing:
        fileMissing(raw.gguf_path) || (raw.mmproj_path ? fileMissing(raw.mmproj_path) : false),
      isActive: activeBase === raw.name,
      isLoaded: isLoaded(raw.name),
    };
  });
}

/**
 * Orphan detection scope follows docs/plans/CONFIG_OVERHAUL_PLAN.md §2.3: GGUFs found
 * under `model_dirs` that no config entry references. `scanForGgufs` also
 * probes the default HF cache dirs as a fallback (same as the scan-picker) —
 * those are included too since they're real, unreferenced disk usage; skipped
 * entirely (no scan at all) when `model_dirs` is empty to keep an unconfigured
 * install fast and quiet.
 */
async function detectOrphans(config: ForgeConfig): Promise<OrphanGguf[]> {
  const dirs = config.model_dirs ?? [];
  if (dirs.length === 0) return [];

  const configured = new Set<string>();
  for (const m of config.models) {
    if (m.gguf_path) configured.add(path.resolve(m.gguf_path));
    if (m.mmproj_path) configured.add(path.resolve(m.mmproj_path));
  }

  const candidates = await scanForGgufs(dirs);
  return candidates
    .filter((c) => !configured.has(path.resolve(c.ggufPath)))
    .map((c) => ({ path: c.ggufPath, sizeBytes: c.sizeBytes }));
}

export async function buildModelManagerState(
  config: ForgeConfig,
  configPath: string,
  isLoaded: (name: string) => boolean,
): Promise<ModelManagerStateMsg> {
  const activeBase = activeBaseName(config);
  const [models, orphans] = await Promise.all([
    buildModelView(config, configPath, isLoaded, activeBase),
    detectOrphans(config),
  ]);

  const modelDiskTotal = models.reduce((sum, m) => sum + (m.sizeBytes ?? 0), 0);
  const orphanTotal = orphans.reduce((sum, o) => sum + o.sizeBytes, 0);

  return {
    type: 'state',
    models,
    groups: config.groups ?? {},
    orphans,
    totalDiskBytes: modelDiskTotal + orphanTotal,
    activeModel: config.active_model,
    modelDirs: config.model_dirs ?? [],
  };
}
