import type { ModelConfig, LlamaServerConfig } from '../config/types';

function normalizeCacheType(value: number | string): string {
  if (typeof value === 'string') return value;

  switch (value) {
    case 0:
      return 'f32';
    case 1:
      return 'f16';
    case 8:
      return 'q8_0';
    default:
      return String(value);
  }
}

/**
 * TS port of llamabridge continue_llamacpp_bridge/llama_server.py _compose_cmd.
 * Composes the argv array for child_process.spawn — never a shell string.
 */
export function composeLlamaServerArgs(
  _binary: string,
  model: ModelConfig,
  server: LlamaServerConfig,
  host: string,
  port: number,
): string[] {
  if (!model.gguf_path) {
    throw new Error(`Model "${model.name}" is missing gguf_path for llama.cpp`);
  }
  const args: string[] = ['-m', model.gguf_path, '--host', host, '--port', String(port), '--jinja'];

  // 999 ("every layer"), not -1. `-ngl -1` used to mean "all layers"; on current
  // llama.cpp (b10430+) it means AUTO-FIT, which keeps a ~1024 MiB margin and
  // strands the overflow on the CPU as tensor overrides. That is a silent
  // slowdown — measured 26 t/s -> 12 t/s on a hybrid model where one CPU layer
  // disabled the fused kernel model-wide. An explicit count also switches
  // auto-fit off entirely, so num_ctx budgets stay under the config's control.
  // Set `n_gpu_layers` per model (or `llama_server.n_gpu_layers`) to offload less.
  const gpuLayers = model.n_gpu_layers ?? server.n_gpu_layers ?? 999;
  args.push('--n-gpu-layers', String(gpuLayers));

  const ctx = model.num_ctx ?? server.default_num_ctx ?? 4096;
  args.push('--ctx-size', String(ctx));

  const batch = model.n_batch ?? server.n_batch ?? 512;
  args.push('--batch-size', String(batch));

  // Default to 4 concurrent slots so a single shared model load can serve a
  // small worker fleet (e.g. parallel subagents) without spawning extra servers.
  // NOTE: --ctx-size below is the TOTAL context split across these slots, so each
  // slot gets ctx / n_parallel — size default_num_ctx/num_ctx accordingly
  // (per-worker-ctx × n_parallel).
  const parallel = model.n_parallel ?? server.n_parallel ?? 4;
  args.push('--parallel', String(parallel));

  const typeK = model.type_k ?? server.type_k ?? 8;
  const typeV = model.type_v ?? server.type_v ?? 8;
  args.push('--cache-type-k', normalizeCacheType(typeK));
  args.push('--cache-type-v', normalizeCacheType(typeV));

  const flash = model.flash_attn ?? server.flash_attn_default ?? true;
  args.push('--flash-attn', flash ? 'on' : 'off');

  if (server.n_threads && server.n_threads > 0) {
    args.push('--threads', String(server.n_threads));
  }
  if (server.n_threads_batch && server.n_threads_batch > 0) {
    args.push('--threads-batch', String(server.n_threads_batch));
  }

  if (model.mmproj_path) {
    args.push('--mmproj', model.mmproj_path);
  }

  if (model.extra_llama_server_args) {
    args.push(...model.extra_llama_server_args);
  }

  return args;
}
