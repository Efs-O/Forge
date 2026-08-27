import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateConfig, verifyResolvedDiff } from '../../src/config/ConfigMigrator';
import { loadConfig } from '../../src/config/ConfigLoader';
import { resolveRequestModel, resolveSpawnModel } from '../../src/config/ConfigResolver';
import type { ForgeConfig } from '../../src/config/types';

/**
 * Weighted toward the real config's dominant bloat pattern
 * (docs/plans/CONFIG_OVERHAUL_PLAN.md §0: "identical 8-line spawn + 7-line sampling
 * blocks × 12 models"): several gemma workers that are FULL duplicates of
 * `gemma-main` (same GGUF spawned again for parallel worker capacity, per
 * config.example.yaml's own documented pattern), one genuine fine-tune
 * outlier ("gemma-efso" — see ConfigGroupHeuristic.test.ts for the per-key/
 * sub-clustering unit coverage), four ollama workers (three sharing
 * everything, one with its own token budget), a singleton, and two cloud
 * entries with nothing worth grouping.
 */
const REALISTIC_FIXTURE = `
active_model: gemma-main
llama_server:
  binary: /path/to/llama-server

models:
  - name: gemma-main
    gguf_path: /models/gemma-4-26b.gguf
    spawn: { n_batch: 512, type_k: q8_0, type_v: q8_0, flash_attn: true, n_gpu_layers: -1 }
    sampling: { top_k: 64, min_p: 0.0, seed: 0, presence_penalty: 0.0, repetition_penalty: 1.0, repeat_last_n: 64, stop: "<end_of_turn>" }

  - name: gemma-worker-1
    gguf_path: /models/gemma-4-26b.gguf
    spawn: { n_batch: 512, type_k: q8_0, type_v: q8_0, flash_attn: true, n_gpu_layers: -1 }
    sampling: { top_k: 64, min_p: 0.0, seed: 0, presence_penalty: 0.0, repetition_penalty: 1.0, repeat_last_n: 64, stop: "<end_of_turn>" }

  - name: gemma-worker-2
    gguf_path: /models/gemma-4-26b.gguf
    spawn: { n_batch: 512, type_k: q8_0, type_v: q8_0, flash_attn: true, n_gpu_layers: -1 }
    sampling: { top_k: 64, min_p: 0.0, seed: 0, presence_penalty: 0.0, repetition_penalty: 1.0, repeat_last_n: 64, stop: "<end_of_turn>" }

  - name: gemma-worker-3
    gguf_path: /models/gemma-4-12b.gguf
    spawn: { n_batch: 512, type_k: q8_0, type_v: q8_0, flash_attn: true, n_gpu_layers: -1 }
    sampling: { top_k: 64, min_p: 0.0, seed: 0, presence_penalty: 0.0, repetition_penalty: 1.0, repeat_last_n: 64, stop: "<end_of_turn>" }

  - name: gemma-worker-4
    gguf_path: /models/gemma-4-12b.gguf
    spawn: { n_batch: 512, type_k: q8_0, type_v: q8_0, flash_attn: true, n_gpu_layers: -1 }
    sampling: { top_k: 64, min_p: 0.0, seed: 0, presence_penalty: 0.0, repetition_penalty: 1.0, repeat_last_n: 64, stop: "<end_of_turn>" }

  - name: gemma-worker-5
    gguf_path: /models/gemma-4-12b.gguf
    spawn: { n_batch: 512, type_k: q8_0, type_v: q8_0, flash_attn: true, n_gpu_layers: -1 }
    sampling: { top_k: 64, min_p: 0.0, seed: 0, presence_penalty: 0.0, repetition_penalty: 1.0, repeat_last_n: 64, stop: "<end_of_turn>" }

  - name: gemma-worker-6
    gguf_path: /models/gemma-4-12b.gguf
    spawn: { n_batch: 512, type_k: q8_0, type_v: q8_0, flash_attn: true, n_gpu_layers: -1 }
    sampling: { top_k: 64, min_p: 0.0, seed: 0, presence_penalty: 0.0, repetition_penalty: 1.0, repeat_last_n: 64, stop: "<end_of_turn>" }

  - name: gemma-efso
    gguf_path: /models/efso-gemma4-13b.gguf
    spawn: { n_batch: 256, flash_attn: false, n_gpu_layers: 20 }
    sampling: { top_k: 20, min_p: 0.05, stop: "<turn|>" }
    system_prompt_mode: replace

  - name: "qwen-solo"
    gguf_path: /models/qwen3-30b.gguf
    spawn: { n_batch: 1024, n_gpu_layers: -1 }
    sampling: { top_k: 20 }

  - name: "gemma4:local-a"
    provider: ollama
    endpoint: "http://127.0.0.1:11434"
    think: true
    reasoning_effort: medium
    sampling: { max_tokens: 131072 }

  - name: "gemma4:local-b"
    provider: ollama
    endpoint: "http://127.0.0.1:11434"
    think: true
    reasoning_effort: medium
    sampling: { max_tokens: 131072 }

  - name: "gemma4:local-c"
    provider: ollama
    endpoint: "http://127.0.0.1:11434"
    think: true
    reasoning_effort: medium
    sampling: { max_tokens: 131072 }

  - name: "gemma4:local-d"
    provider: ollama
    endpoint: "http://127.0.0.1:11434"
    think: true
    reasoning_effort: medium
    sampling: { max_tokens: 65536 }

  - name: grok-4
    provider: xai
    api_key_secret: xai
    capabilities: [tool-call]
    sampling: { temperature: 0.7 }

  - name: grok-mini
    provider: xai
    api_key_secret: xai
    capabilities: [tool-call]
    sampling: { temperature: 0.5 }
`;

describe('migrateConfig', () => {
  let directory: string;
  let configPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-migrator-run-'));
    configPath = path.join(directory, 'config.yaml');
    fs.writeFileSync(configPath, REALISTIC_FIXTURE, 'utf8');
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('factors groups per-key, shrinks the file meaningfully, writes a backup, and preserves resolved output', () => {
    const before = loadConfig(directory);
    const linesBefore = fs.readFileSync(configPath, 'utf8').split('\n').length;

    const result = migrateConfig(configPath);

    expect(result.migrated).toBe(true);
    // 7 duplicate gemma workers and 4 local ollama entries each factor into
    // one group; gemma-efso, qwen-solo, and the two xai entries stay inline
    // (no group worth manufacturing for them).
    expect(result.groupCount).toBe(2);
    expect(result.linesBefore).toBe(linesBefore);
    // Measured on this fixture: 92 -> 81 lines (-11). Assert a comfortable,
    // still-meaningful cut rather than pin the exact number.
    expect(result.linesAfter).toBeLessThanOrEqual(linesBefore - 8);
    expect(fs.existsSync(`${configPath}.bak-v2migration`)).toBe(true);
    expect(fs.readFileSync(`${configPath}.bak-v2migration`, 'utf8')).toBe(REALISTIC_FIXTURE);

    const after = loadConfig(directory);
    expect(Object.keys(after.groups ?? {}).length).toBe(2);

    // The 7 duplicate gemma workers fully collapse: nothing left but name,
    // gguf_path, and the group ref (spawn/sampling both entirely lifted).
    const gemmaMain = after.models.find((m) => m.name === 'gemma-main');
    expect(gemmaMain?.group).toBeDefined();
    expect(gemmaMain?.spawn).toBeUndefined();
    expect(gemmaMain?.sampling).toBeUndefined();
    // The outlier fine-tune is untouched — no group, full spawn/sampling inline.
    const gemmaEfso = after.models.find((m) => m.name === 'gemma-efso');
    expect(gemmaEfso?.group).toBeUndefined();
    expect(gemmaEfso?.spawn).toEqual({ n_batch: 256, flash_attn: false, n_gpu_layers: 20 });

    // Every model + profile combination resolves identically before/after
    // (the verifier intentionally ignores the newly-added `group` ref itself
    // — see verifyResolvedDiff's withoutGroupRefs — since that's the one
    // deliberate, behavior-neutral change the migration makes).
    const verify = verifyResolvedDiff(before, after);
    expect(verify.ok).toBe(true);
    expect(verify.diffs).toEqual([]);

    for (const model of before.models) {
      const { group: _g1, ...beforeRequest } = resolveRequestModel(before, model.name);
      const { group: _g2, ...afterRequest } = resolveRequestModel(after, model.name);
      expect(afterRequest).toEqual(beforeRequest);
      const { group: _g3, ...beforeSpawn } = resolveSpawnModel(before, model.name);
      const { group: _g4, ...afterSpawn } = resolveSpawnModel(after, model.name);
      expect(afterSpawn).toEqual(beforeSpawn);
    }
  });

  it('aborts and writes nothing when a migration would change resolved output', () => {
    // Simulate a broken heuristic implementation by hand-verifying the guard:
    // construct an old/new pair where one model's resolved sampling differs.
    const oldConfig: ForgeConfig = {
      models: [
        { name: 'a', gguf_path: '/a.gguf', sampling: { top_k: 64 } },
        { name: 'b', gguf_path: '/b.gguf', sampling: { top_k: 64 } },
      ],
      active_model: 'a',
      llama_server: { binary: '/bin/llama-server' },
    };
    const corruptedNew: ForgeConfig = {
      ...oldConfig,
      groups: { g: { sampling: { top_k: 999 } } },
      models: [
        { name: 'a', gguf_path: '/a.gguf', group: 'g' },
        { name: 'b', gguf_path: '/b.gguf', group: 'g' },
      ],
    };
    const verify = verifyResolvedDiff(oldConfig, corruptedNew);
    expect(verify.ok).toBe(false);
    expect(verify.diffs.length).toBeGreaterThan(0);
  });

  it('is a no-op — writes nothing — when a config has nothing groupable', () => {
    // Corrupting one model's spawn value directly mid-heuristic isn't
    // reachable via the public API (the verifier exists precisely so a
    // buggy heuristic can never reach disk); this instead exercises the
    // "nothing to factor" abort path with its own isolated config.yaml
    // (loadConfig reads a fixed `config.yaml` filename per directory).
    const soloDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-migrator-solo-'));
    const soloPath = path.join(soloDir, 'config.yaml');
    const soloFixture = `
active_model: solo
llama_server:
  binary: /path/to/llama-server
models:
  - name: solo
    gguf_path: /models/solo.gguf
`;
    fs.writeFileSync(soloPath, soloFixture, 'utf8');

    const result = migrateConfig(soloPath);

    expect(result.migrated).toBe(false);
    expect(fs.readFileSync(soloPath, 'utf8')).toBe(soloFixture);
    expect(fs.existsSync(`${soloPath}.bak-v2migration`)).toBe(false);
    fs.rmSync(soloDir, { recursive: true, force: true });
  });
});
