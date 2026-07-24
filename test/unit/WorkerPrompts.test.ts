import { describe, expect, it } from 'vitest';
import {
  addWorkerDelegationInstructions,
  buildWorkerCatalog,
  buildWorkerReviewPrompt,
} from '../../src/workers/WorkerPrompts';
import type { ForgeConfig } from '../../src/config/types';

describe('worker coordinator prompts', () => {
  it('teaches an enabled coordinator to discover and dispatch models', () => {
    const messages = addWorkerDelegationInstructions(
      [
        { role: 'system', content: 'base' },
        { role: 'user', content: 'task' },
      ],
      true,
    );
    expect(messages[0]?.content).toContain('call list_worker_models');
    expect(messages[0]?.content).toContain('call dispatch_workers');
    expect(messages[1]).toEqual({ role: 'user', content: 'task' });
  });

  it('limits review to verified changed paths', () => {
    const prompt = buildWorkerReviewPrompt({
      runId: 'run',
      status: 'completed',
      executionMode: 'parallel',
      workers: [
        {
          id: 'one',
          model: 'local',
          status: 'completed',
          summary: 'done',
          changedPaths: ['src/a.ts'],
        },
      ],
    });
    expect(prompt).toContain('Verified worker-changed paths:\n- src/a.ts');
    expect(prompt).toContain('unrelated pre-existing worktree changes');
  });

  it('avoids repository-wide diffing when workers changed nothing', () => {
    const prompt = buildWorkerReviewPrompt({
      runId: 'run',
      status: 'completed',
      executionMode: 'best-effort',
      workers: [
        {
          id: 'one',
          model: 'local',
          status: 'completed_no_changes',
          summary: 'reviewed',
          changedPaths: [],
        },
      ],
    });
    expect(prompt).toContain('no verified file changes');
    expect(prompt).toContain('Do not run repository-wide git status or diff');
  });
});

function catalogConfig(): ForgeConfig {
  return {
    models: [
      {
        name: 'gemma4-26b-a4b-it-iq3s',
        provider: 'llama.cpp',
        gguf_path: '/m.gguf',
        short_name: 'gemma4',
      },
      { name: 'qwen3-30b-worker', provider: 'llama.cpp', gguf_path: '/q.gguf' },
      { name: 'cloud-model', provider: 'openai', api_key_secret: 'k' },
    ],
    active_model: 'gemma4-26b-a4b-it-iq3s',
    aliases: { 'qwen-worker': 'qwen3-30b-worker' },
    llama_server: { binary: 'llama-server' },
  };
}

describe('buildWorkerCatalog', () => {
  it('lists eligible local models using short_name/alias as the compact label', () => {
    const catalog = buildWorkerCatalog(catalogConfig(), false);
    expect(catalog).toContain('gemma4 → gemma4-26b-a4b-it-iq3s');
    expect(catalog).toContain('qwen-worker → qwen3-30b-worker');
  });

  it('excludes cloud models unless includeCloud is true', () => {
    const withoutCloud = buildWorkerCatalog(catalogConfig(), false);
    expect(withoutCloud).not.toContain('cloud-model');

    const withCloud = buildWorkerCatalog(catalogConfig(), true);
    expect(withCloud).toContain('cloud-model');
  });

  it('returns empty string when there are no models', () => {
    const empty: ForgeConfig = { models: [], active_model: null, llama_server: {} };
    expect(buildWorkerCatalog(empty, false)).toBe('');
  });

  it('falls back to the bare model name when no short_name or alias exists', () => {
    const cfg: ForgeConfig = {
      models: [{ name: 'plain-model', provider: 'llama.cpp', gguf_path: '/p.gguf' }],
      active_model: 'plain-model',
      llama_server: {},
    };
    const catalog = buildWorkerCatalog(cfg, false);
    expect(catalog).toContain('plain-model');
    expect(catalog).not.toContain('→');
  });
});

describe('addWorkerDelegationInstructions with catalog', () => {
  it('appends the catalog after the delegation instructions when provided', () => {
    const messages = addWorkerDelegationInstructions(
      [{ role: 'system', content: 'base' }],
      true,
      'Available workers (dispatch_workers "model" field accepts these):\ngemma4 → gemma4-26b',
    );
    const content = messages[0]?.content as string;
    expect(content).toContain('call dispatch_workers');
    expect(content.indexOf('call dispatch_workers')).toBeLessThan(content.indexOf('gemma4 →'));
  });

  it('omits the catalog block when none is given, unchanged from prior behavior', () => {
    const messages = addWorkerDelegationInstructions([{ role: 'system', content: 'base' }], true);
    expect(messages[0]?.content).not.toContain('Available workers');
  });
});
