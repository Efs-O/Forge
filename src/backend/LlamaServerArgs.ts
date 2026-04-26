import type { ModelConfig, LlamaServerConfig } from '../config/types';

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
  const args: string[] = [
    '-m', model.gguf_path,
    '--host', host,
    '--port', String(port),
    '--jinja',
  ];

  const gpuLayers = model.n_gpu_layers ?? server.n_gpu_layers ?? -1;
  args.push('--n-gpu-layers', String(gpuLayers));

  const ctx = model.num_ctx ?? server.default_num_ctx ?? 4096;
  args.push('--ctx-size', String(ctx));

  const batch = model.n_batch ?? server.n_batch ?? 512;
  args.push('--batch-size', String(batch));

  const parallel = server.n_parallel ?? 1;
  args.push('--parallel', String(parallel));

  const typeK = model.type_k ?? server.type_k ?? 8;
  const typeV = model.type_v ?? server.type_v ?? 8;
  args.push('--cache-type-k', String(typeK));
  args.push('--cache-type-v', String(typeV));

  const flash = model.flash_attn ?? server.flash_attn_default ?? true;
  args.push(flash ? '--flash-attn' : '--no-flash-attn');

  if (server.n_threads && server.n_threads > 0) {
    args.push('--threads', String(server.n_threads));
  }
  if (server.n_threads_batch && server.n_threads_batch > 0) {
    args.push('--threads-batch', String(server.n_threads_batch));
  }

  if (model.extra_llama_server_args) {
    args.push(...model.extra_llama_server_args);
  }

  return args;
}
