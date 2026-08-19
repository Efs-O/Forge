import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/config/types';
import { resolveRequestModel } from '../../src/config/ConfigResolver';
import {
  MAX_CONFIGURABLE_TOOL_ROUNDS,
  MAX_TOOL_ROUNDS,
  resolveMaxToolRounds,
} from '../../src/sidebar/ModelTurn';

const model = (over: Partial<ModelConfig> = {}): ModelConfig =>
  ({ name: 'test', ...over }) as ModelConfig;

describe('resolveMaxToolRounds', () => {
  it('falls back to the built-in default when unset', () => {
    expect(resolveMaxToolRounds(model())).toBe(MAX_TOOL_ROUNDS);
  });

  it('honours a configured budget', () => {
    // The case this exists for: a multi-file refactor that legitimately spends
    // more rounds than a chat turn ever would.
    expect(resolveMaxToolRounds(model({ max_tool_rounds: 150 }))).toBe(150);
  });

  it('still bounds a runaway configuration', () => {
    expect(resolveMaxToolRounds(model({ max_tool_rounds: 100_000 }))).toBe(
      MAX_CONFIGURABLE_TOOL_ROUNDS,
    );
    expect(resolveMaxToolRounds(model({ max_tool_rounds: 0 }))).toBe(1);
  });

  it('floors a fractional budget rather than passing it to the loop', () => {
    expect(resolveMaxToolRounds(model({ max_tool_rounds: 12.9 }))).toBe(12);
  });
});

describe('max_tool_rounds through the config layers', () => {
  const cfg = (over: Record<string, unknown>) =>
    ({
      models: [{ name: 'm', provider: 'llama.cpp', gguf_path: 'x.gguf' }],
      active_model: 'm',
      ...over,
    }) as never;

  it('applies a defaults value to every model', () => {
    // One setting for the whole config, rather than repeating it per entry.
    const resolved = resolveRequestModel(cfg({ defaults: { max_tool_rounds: 80 } }), 'm');
    expect(resolveMaxToolRounds(resolved)).toBe(80);
  });

  it('lets a model override the default', () => {
    const resolved = resolveRequestModel(
      cfg({
        defaults: { max_tool_rounds: 80 },
        models: [
          { name: 'm', provider: 'llama.cpp', gguf_path: 'x.gguf', max_tool_rounds: 200 },
        ],
      }),
      'm',
    );
    expect(resolveMaxToolRounds(resolved)).toBe(200);
  });

  it('falls back to the built-in default when nothing sets it', () => {
    expect(resolveMaxToolRounds(resolveRequestModel(cfg({}), 'm'))).toBe(MAX_TOOL_ROUNDS);
  });
});
