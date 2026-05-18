import { describe, it, expect } from 'vitest';
import { composeLlamaServerArgs } from '../../src/backend/LlamaServerArgs';
import type { ModelConfig, LlamaServerConfig } from '../../src/config/types';

const serverDefaults: LlamaServerConfig = {
  binary: '/usr/local/bin/llama-server',
  n_gpu_layers: -1,
  default_num_ctx: 4096,
  n_batch: 512,
  n_parallel: 1,
  type_k: 8,
  type_v: 8,
  flash_attn_default: true,
};

const baseModel: ModelConfig = {
  name: 'test-model',
  gguf_path: '/models/test.gguf',
};

describe('composeLlamaServerArgs', () => {
  it('includes required flags', () => {
    const args = composeLlamaServerArgs('', baseModel, serverDefaults, '127.0.0.1', 8080);
    expect(args).toContain('-m');
    expect(args).toContain('/models/test.gguf');
    expect(args).toContain('--host');
    expect(args).toContain('127.0.0.1');
    expect(args).toContain('--port');
    expect(args).toContain('8080');
    expect(args).toContain('--jinja');
  });

  it('uses server defaults when model does not override', () => {
    const args = composeLlamaServerArgs('', baseModel, serverDefaults, '127.0.0.1', 8080);
    expect(args).toContain('--n-gpu-layers');
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('-1');
    expect(args).toContain('--ctx-size');
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('4096');
    expect(args[args.indexOf('--cache-type-k') + 1]).toBe('q8_0');
    expect(args[args.indexOf('--cache-type-v') + 1]).toBe('q8_0');
    expect(args).toContain('--flash-attn');
    expect(args[args.indexOf('--flash-attn') + 1]).toBe('on');
  });

  it('prefers model overrides over server defaults', () => {
    const model: ModelConfig = {
      ...baseModel,
      n_gpu_layers: 32,
      num_ctx: 8192,
      flash_attn: false,
    };
    const args = composeLlamaServerArgs('', model, serverDefaults, '127.0.0.1', 8080);
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('32');
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('8192');
    expect(args).toContain('--flash-attn');
    expect(args[args.indexOf('--flash-attn') + 1]).toBe('off');
  });

  it('appends extra_llama_server_args verbatim', () => {
    const model: ModelConfig = {
      ...baseModel,
      extra_llama_server_args: ['--verbose', '--log-format', 'json'],
    };
    const args = composeLlamaServerArgs('', model, serverDefaults, '127.0.0.1', 8080);
    expect(args).toContain('--verbose');
    expect(args).toContain('--log-format');
    expect(args).toContain('json');
  });

  it('passes through string cache types verbatim', () => {
    const server: LlamaServerConfig = {
      ...serverDefaults,
      type_k: 'q4_0',
      type_v: 'f16',
    };
    const args = composeLlamaServerArgs('', baseModel, server, '127.0.0.1', 8080);
    expect(args[args.indexOf('--cache-type-k') + 1]).toBe('q4_0');
    expect(args[args.indexOf('--cache-type-v') + 1]).toBe('f16');
  });

  it('omits --threads when not set', () => {
    const args = composeLlamaServerArgs('', baseModel, serverDefaults, '127.0.0.1', 8080);
    expect(args).not.toContain('--threads');
  });

  it('includes --threads when n_threads > 0', () => {
    const server: LlamaServerConfig = { ...serverDefaults, n_threads: 8 };
    const args = composeLlamaServerArgs('', baseModel, server, '127.0.0.1', 8080);
    expect(args).toContain('--threads');
    expect(args[args.indexOf('--threads') + 1]).toBe('8');
  });
});
