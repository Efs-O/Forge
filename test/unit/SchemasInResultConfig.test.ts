import { describe, expect, it } from 'vitest';
import { resolveRequestModel } from '../../src/config/ConfigResolver';
import { assertTextCallsReadable } from '../../src/sidebar/turnToolDefinitions';
import type { DefaultsConfig, ForgeConfig, ModelConfig } from '../../src/config/types';

const CONFLICT =
  'tool_groups.schemas_in_result needs Forge to read tool calls written as text; ' +
  'text_tool_calls: native turns that off. Remove one of the two.';

/** The A1 text, read off `.message` rather than matched as a substring. */
function conflictMessage(model: ModelConfig): string | undefined {
  try {
    assertTextCallsReadable(model);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/** The conflict is checked on the RESOLVED model, so it must be caught whatever
 *  level `text_tool_calls` arrived from: defaults, the entry, or a profile. */
function config(
  entry: Partial<ModelConfig>,
  defaults?: DefaultsConfig,
  profiles?: ForgeConfig['profiles'],
): ForgeConfig {
  return {
    models: [{ name: 'strata', provider: 'llama.cpp', gguf_path: '/m.gguf', ...entry }],
    active_model: 'strata',
    ...(defaults ? { defaults } : {}),
    ...(profiles ? { profiles } : {}),
    llama_server: { binary: 'llama-server' },
  } as ForgeConfig;
}

describe('tool_groups.schemas_in_result config', () => {
  it('leaves the flag off and throws nothing when the config does not set it', () => {
    const cfg = config({ tool_groups: { eager: ['agents'] } });
    const model = resolveRequestModel(cfg, 'strata');
    expect(model.tool_groups?.schemas_in_result).toBeUndefined();
    expect(conflictMessage(model)).toBeUndefined();
  });

  it('names the conflict when the entry turns the flag on and defaults set native', () => {
    const cfg = config(
      { tool_groups: { eager: [], schemas_in_result: true } },
      { text_tool_calls: 'native' },
    );
    const model = resolveRequestModel(cfg, 'strata');
    expect(model.text_tool_calls).toBe('native');
    expect(conflictMessage(model)).toBe(CONFLICT);
  });

  it('names the conflict when native comes from the profile instead of defaults', () => {
    const cfg = config(
      { tool_groups: { eager: [], schemas_in_result: true }, profiles: ['strict'] },
      undefined,
      { strict: { text_tool_calls: 'native' } },
    );
    const model = resolveRequestModel(cfg, 'strata@strict');
    expect(model.text_tool_calls).toBe('native');
    expect(conflictMessage(model)).toBe(CONFLICT);
  });

  it('accepts the flag alone', () => {
    const cfg = config({ tool_groups: { eager: [], schemas_in_result: true } });
    expect(conflictMessage(resolveRequestModel(cfg, 'strata'))).toBeUndefined();
  });
});
