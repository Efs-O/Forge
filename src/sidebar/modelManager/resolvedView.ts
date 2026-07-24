import type { ForgeConfig, ModelConfig, ProfileConfig } from '../../config/types';
import { mergeGroupsIntoModel } from '../../config/ConfigResolver';

/**
 * Resolved-view helpers for the Model Manager (F7/§2.3): fold `group(s)` and
 * `defaults` into a raw model entry for display, and report which top-level
 * keys were explicit on the raw entry so the webview can grey out anything
 * that's merely inherited. Split out of modelSnapshot.ts to stay under the
 * 350-LOC file limit. See docs/OWNERS.md.
 */

// Request-time profile fields `defaults` can supply (ConfigResolver.resolveRequestModel
// mirrors this set — kept in sync manually since ProfileConfig has no key-list export).
const DEFAULTS_FIELDS: (keyof ProfileConfig)[] = [
  'system_prompt',
  'system_prompt_mode',
  'sampling',
  'think',
  'reasoning_effort',
  'strip_tools',
  'strip_thinking_channels',
  'capabilities',
];

/** `raw` with `group`/`groups` merged in, then any still-undefined
 *  request-time field filled from `config.defaults` (lowest precedence). */
export function resolveModelForDisplay(config: ForgeConfig, raw: ModelConfig): ModelConfig {
  const groupMerged = mergeGroupsIntoModel(config, raw);
  const defaults = config.defaults;
  if (!defaults) return groupMerged;

  const out = { ...groupMerged } as unknown as Record<string, unknown>;
  const defaultsRecord = defaults as unknown as Record<string, unknown>;
  for (const field of DEFAULTS_FIELDS) {
    if (out[field] === undefined && defaultsRecord[field] !== undefined) {
      out[field] = defaultsRecord[field];
    }
  }
  return out as unknown as ModelConfig;
}

/** Top-level keys explicitly set on the raw config entry (excluding `name`) —
 *  anything in `resolved` but not here came from a group or `defaults`. */
export function overrideKeysOf(raw: ModelConfig): string[] {
  const record = raw as unknown as Record<string, unknown>;
  return Object.keys(record).filter((k) => k !== 'name' && record[k] !== undefined);
}
