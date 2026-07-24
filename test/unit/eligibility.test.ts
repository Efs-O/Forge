import { describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { resolveDelegationTarget } from '../../src/delegation/eligibility';

function config(models: ForgeConfig['models']): ForgeConfig {
  return { models, active_model: models[0]?.name ?? null, llama_server: {} };
}

describe('resolveDelegationTarget provider: cli', () => {
  it('accepts a cli target as a valid local delegation/worker target', () => {
    const target = resolveDelegationTarget(
      config([{ name: 'claude-code', provider: 'cli', cli: 'claude' }]),
      'claude-code',
    );
    expect(target.provider).toBe('cli');
    expect(target.baseModel).toBe('claude-code');
    expect(target.resolvedId).toBe('claude-code');
  });

  it('resolves cli targets through short_name/alias like any other model', () => {
    const target = resolveDelegationTarget(
      config([{ name: 'claude-code', provider: 'cli', cli: 'claude', short_name: 'claude' }]),
      'claude',
    );
    expect(target.provider).toBe('cli');
    expect(target.baseModel).toBe('claude-code');
  });
});
