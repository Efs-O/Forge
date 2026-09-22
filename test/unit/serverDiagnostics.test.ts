import { describe, expect, it } from 'vitest';
import { describeStartupFailure } from '../../src/backend/serverDiagnostics';

describe('describeStartupFailure', () => {
  it('names the VRAM settings when the model does not fit', () => {
    for (const tail of [
      'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9000 MiB on device 0: cudaMalloc failed: out of memory',
      'llama_model_load: error loading model: unable to allocate CUDA0 buffer',
      'ggml_vulkan: failed to allocate device memory',
    ]) {
      const message = describeStartupFailure(tail);
      expect(message).toContain('n_gpu_layers');
      expect(message).toContain('num_ctx');
    }
  });

  it('passes any other cause through, keeping the end where llama.cpp puts it', () => {
    const tail = `${'x'.repeat(500)} error: unknown argument: --bogus`;
    const message = describeStartupFailure(tail);
    expect(message).toContain('unknown argument: --bogus');
    expect(message).not.toContain('n_gpu_layers');
    expect(message.length).toBeLessThan(320);
  });

  it('adds nothing when stderr was empty', () => {
    expect(describeStartupFailure('  ')).toBe('');
  });

  it('does not read a memory word inside a path as out-of-memory', () => {
    expect(describeStartupFailure('failed to open C:/models/memory-allocate.gguf')).not.toContain(
      'n_gpu_layers',
    );
  });
});
