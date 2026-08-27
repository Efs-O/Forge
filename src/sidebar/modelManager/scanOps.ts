import * as path from 'path';
import type { ForgeConfig, ModelConfig, SamplingConfig } from '../../config/types';
import { extractQuant, scanForGgufs } from '../../backend/GgufScanner';
import { deriveModelSuggestion, detectFamily } from '../../backend/ModelHeuristics';
import { updateConfigFile, addModel } from '../../config/ConfigWriter';
import type { ScanCandidateView } from './messages';

/**
 * "Acquire → Register" flow for the Model Manager (F7/§2.3 step 1-2, §2.5).
 * Scan-only (Q8: no in-UI downloads) — the user picks a directory already
 * containing GGUFs they downloaded themselves; this module turns the results
 * into config entries. See docs/OWNERS.md.
 */

/** Scan `dir` and return candidates flagged against models already configured
 *  in `config`, for the webview's add-checkbox list. */
export async function scanDirectoryForCandidates(
  config: ForgeConfig,
  dir: string,
): Promise<ScanCandidateView[]> {
  const configured = new Set(
    config.models
      .map((m) => m.gguf_path)
      .filter((p): p is string => Boolean(p))
      .map((p) => path.resolve(p)),
  );
  const candidates = await scanForGgufs([dir]);
  return candidates.map((c) => ({
    ggufPath: c.ggufPath,
    suggestedName: c.modelName,
    sizeBytes: c.sizeBytes,
    family: c.familyHint,
    ...(c.quant !== undefined ? { quant: c.quant } : {}),
    ...(c.mmprojPath !== undefined ? { mmprojPath: c.mmprojPath } : {}),
    alreadyConfigured: configured.has(path.resolve(c.ggufPath)),
  }));
}

/** Family-specific sampling defaults for a flat (no matching group) new
 *  entry — matches docs/plans/CONFIG_OVERHAUL_PLAN.md §2.3's stated conventions. */
function familySamplingDefaults(family: string): SamplingConfig | undefined {
  if (family === 'gemma4') return { top_k: 64, stop: '<end_of_turn>' };
  if (family === 'qwen3') return { top_k: 20 };
  return undefined;
}

/** Find an existing group already used by a same-family, same-provider model
 *  — "matching group" per §2.3 ("new qwen → qwen board"). Returns undefined
 *  when no configured model of this family opts into a group yet. */
function findMatchingGroup(config: ForgeConfig, family: string): string | undefined {
  for (const m of config.models) {
    if (!m.gguf_path) continue;
    if ((m.provider ?? 'llama.cpp') !== 'llama.cpp') continue;
    if (detectFamily(m.gguf_path) !== family) continue;
    const group = m.groups?.[0] ?? m.group;
    if (group) return group;
  }
  return undefined;
}

export interface ScanPick {
  ggufPath: string;
  name: string;
  mmprojPath?: string;
}

/** Auto-generate a config entry for one scan pick: attach a matching group
 *  when one exists, else write family-convention spawn/sampling defaults
 *  directly (§2.3/§2.5). */
export function buildModelConfigForPick(config: ForgeConfig, pick: ScanPick): ModelConfig {
  const family = detectFamily(pick.ggufPath);
  const quant = extractQuant(path.basename(pick.ggufPath));
  const suggestion = deriveModelSuggestion({
    ggufPath: pick.ggufPath,
    modelName: pick.name,
    sizeBytes: 0,
    familyHint: family,
    ...(quant !== undefined ? { quant } : {}),
  });
  const matchingGroup = findMatchingGroup(config, family);

  const base: ModelConfig = {
    name: pick.name,
    provider: 'llama.cpp',
    gguf_path: pick.ggufPath,
    ...(pick.mmprojPath ? { mmproj_path: pick.mmprojPath } : {}),
  };

  if (matchingGroup) {
    return { ...base, group: matchingGroup };
  }

  const sampling = familySamplingDefaults(family);
  const flat: ModelConfig = {
    ...base,
    spawn: {
      num_ctx: suggestion.numCtx,
      n_batch: suggestion.nBatch,
      flash_attn: suggestion.flashAttn,
    },
  };
  return sampling ? { ...flat, sampling } : flat;
}

/** Write all picks as new model entries in a single config mutation. Throws
 *  (writes nothing) if any generated name collides with an existing entry or
 *  the resulting config is schema-invalid. */
export function addScannedModels(configPath: string, config: ForgeConfig, picks: ScanPick[]): void {
  const existingNames = new Set(config.models.map((m) => m.name));
  for (const pick of picks) {
    if (existingNames.has(pick.name)) {
      throw new Error(`Forge: model name "${pick.name}" already exists in config`);
    }
    existingNames.add(pick.name);
  }
  updateConfigFile(configPath, (doc) => {
    for (const pick of picks) addModel(doc, buildModelConfigForPick(config, pick));
  });
}
