import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { computeGroups } from '../../src/config/ConfigGroupHeuristic';
import { loadConfig } from '../../src/config/ConfigLoader';

/**
 * A gemma llama.cpp family that shares most — but not every — spawn/
 * sampling key (num_ctx/n_parallel/extra_llama_server_args genuinely differ
 * per model, exercising per-key lifting), one fine-tune outlier
 * ("gemma-efso") whose entire spawn+sampling disagrees with the majority
 * (exercising the sub-clustering fallback), ollama entries sharing
 * endpoint/think/reasoning_effort but not sampling.max_tokens, and cloud
 * entries with nothing worth grouping.
 */
const FIXTURE = `
active_model: gemma-main
llama_server:
  binary: /path/to/llama-server

models:
  - name: gemma-main
    gguf_path: /models/gemma-4-26b.gguf
    spawn: { n_batch: 512, type_k: q8_0, type_v: q8_0, flash_attn: true, n_gpu_layers: -1, num_ctx: 32768 }
    sampling: { top_k: 64, min_p: 0.0, seed: 0, presence_penalty: 0.0, repetition_penalty: 1.0, repeat_last_n: 64, stop: "<end_of_turn>" }

  - name: gemma-worker-1
    gguf_path: /models/gemma-4-26b.gguf
    spawn: { n_batch: 512, type_k: q8_0, type_v: q8_0, flash_attn: true, n_gpu_layers: -1, num_ctx: 16384, n_parallel: 4 }
    sampling: { top_k: 64, min_p: 0.0, seed: 0, presence_penalty: 0.0, repetition_penalty: 1.0, repeat_last_n: 64, stop: "<end_of_turn>" }

  - name: gemma-worker-2
    gguf_path: /models/gemma-4-12b.gguf
    spawn: { n_batch: 512, type_k: q8_0, type_v: q8_0, flash_attn: true, n_gpu_layers: -1, num_ctx: 8192 }
    sampling: { top_k: 64, min_p: 0.0, seed: 0, presence_penalty: 0.0, repetition_penalty: 1.0, repeat_last_n: 64, stop: "<end_of_turn>" }

  - name: gemma-worker-3
    gguf_path: /models/gemma-4-12b.gguf
    spawn: { n_batch: 512, type_k: q8_0, type_v: q8_0, flash_attn: true, n_gpu_layers: -1, num_ctx: 8192, extra_llama_server_args: ["--reasoning-budget", "4096"] }
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

describe('computeGroups', () => {
  it('lifts per-key: shared spawn/sampling keys move to the group, differing keys (num_ctx, n_parallel, extra_llama_server_args) stay inline per model', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-heuristic-compute-'));
    fs.writeFileSync(path.join(directory, 'config.yaml'), FIXTURE, 'utf8');
    const config = loadConfig(directory);
    const computed = computeGroups(config);

    expect(computed.assignment['gemma-main']).toBeDefined();
    expect(computed.assignment['gemma-main']).toBe(computed.assignment['gemma-worker-1']);
    expect(computed.assignment['gemma-main']).toBe(computed.assignment['gemma-worker-2']);
    expect(computed.assignment['gemma-main']).toBe(computed.assignment['gemma-worker-3']);
    // The efso fine-tune disagrees on every spawn/sampling key it shares with
    // the majority (n_batch/flash_attn/n_gpu_layers/top_k/min_p/stop) — the
    // sub-clustering fallback isolates it into its own (size-1, dropped)
    // bucket rather than either blocking or diluting the majority's group.
    expect(computed.assignment['gemma-efso']).toBeUndefined();
    expect(computed.assignment['qwen-solo']).toBeUndefined();
    expect(computed.assignment['gemma4:local-a']).toBeDefined();
    expect(computed.assignment['gemma4:local-a']).toBe(computed.assignment['gemma4:local-b']);
    // grok-4/grok-mini share only `provider`+`capabilities` — neither is a
    // "bloat" field (spawn/sampling/endpoint), and their sampling differs, so
    // the heuristic leaves both inline rather than manufacturing a group.
    expect(computed.assignment['grok-4']).toBeUndefined();
    expect(computed.assignment['grok-mini']).toBeUndefined();

    const gemmaGroupName = computed.assignment['gemma-main'];
    const gemmaGroup = computed.groups[gemmaGroupName];
    // Per-key lift: shared across all 4 majority members.
    expect(gemmaGroup.spawn).toEqual({
      n_batch: 512,
      type_k: 'q8_0',
      type_v: 'q8_0',
      flash_attn: true,
      n_gpu_layers: -1,
    });
    expect(gemmaGroup.sampling).toEqual({
      top_k: 64,
      min_p: 0.0,
      seed: 0,
      presence_penalty: 0.0,
      repetition_penalty: 1.0,
      repeat_last_n: 64,
      stop: '<end_of_turn>',
    });
    // num_ctx/n_parallel/extra_llama_server_args genuinely differ per member
    // — never lifted, stay as per-model overrides alongside the group ref.
    expect(gemmaGroup.num_ctx).toBeUndefined();
    expect(computed.removedFields['gemma-main']).not.toContain('spawn.num_ctx');
    expect(computed.removedFields['gemma-worker-1']).not.toContain('spawn.num_ctx');
    expect(computed.removedFields['gemma-worker-1']).not.toContain('spawn.n_parallel');
    expect(computed.removedFields['gemma-worker-3']).not.toContain('spawn.extra_llama_server_args');

    const ollamaGroup = computed.groups[computed.assignment['gemma4:local-a']];
    // sampling.max_tokens differs between the two ollama entries, so it must
    // stay inline rather than being folded into the shared group.
    expect(ollamaGroup.sampling).toBeUndefined();
    expect(ollamaGroup.endpoint).toBe('http://127.0.0.1:11434');
    expect(ollamaGroup.think).toBe(true);

    fs.rmSync(directory, { recursive: true, force: true });
  });
});
