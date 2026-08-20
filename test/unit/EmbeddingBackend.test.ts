import { describe, expect, it } from 'vitest';
import { composeEmbeddingServerArgs, embeddingModelMatches } from '../../src/backend/EmbeddingBackend';
import type { ForgeConfig } from '../../src/config/types';

function makeConfig(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
  return {
    models: [],
    active_model: null,
    llama_server: { binary: '/bin/llama-server' },
    embeddings: { enabled: true, model_path: '/models/embeddinggemma-300m.gguf' },
    ...overrides,
  } as ForgeConfig;
}

/** Reads the value following `flag` in the composed argv. */
function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('composeEmbeddingServerArgs', () => {
  it('throws when model_path is missing', () => {
    const config = makeConfig({ embeddings: { enabled: true } });
    expect(() => composeEmbeddingServerArgs(config)).toThrow(/model_path is not configured/);
  });

  it('sets ubatch equal to ctx so a whole chunk fits one physical batch', () => {
    // Regression: llama.cpp pools embeddings non-causally and cannot split an
    // input across physical batches. Without an explicit --ubatch-size it
    // defaults to 512 and rejects real chunks with HTTP 500 "input is too
    // large to process". Verified against llama-server b9402: a 1105-token
    // chunk returns 500 without these flags and 200 with them.
    const args = composeEmbeddingServerArgs(makeConfig());
    expect(argValue(args, '--ubatch-size')).toBe('2048');
    expect(argValue(args, '--batch-size')).toBe('2048');
    expect(argValue(args, '--ctx-size')).toBe('2048');
  });

  it('honours embeddings.n_ctx across ctx, batch and ubatch together', () => {
    const config = makeConfig({
      embeddings: { enabled: true, model_path: '/models/e.gguf', n_ctx: 4096 },
    });
    const args = composeEmbeddingServerArgs(config);
    expect(argValue(args, '--ctx-size')).toBe('4096');
    expect(argValue(args, '--batch-size')).toBe('4096');
    expect(argValue(args, '--ubatch-size')).toBe('4096');
  });

  it('does not inherit the chat model ctx/batch, which describe a different model', () => {
    const config = makeConfig({
      llama_server: { binary: '/bin/llama-server', default_num_ctx: 262144, n_batch: 512 },
    });
    const args = composeEmbeddingServerArgs(config);
    expect(argValue(args, '--ctx-size')).toBe('2048');
    expect(argValue(args, '--batch-size')).toBe('2048');
  });

  it('passes model path, embedding flag and configured port', () => {
    const config = makeConfig({
      embeddings: { enabled: true, model_path: '/models/e.gguf', port: 8099 },
    });
    const args = composeEmbeddingServerArgs(config);
    expect(args).toContain('--embedding');
    expect(argValue(args, '-m')).toBe('/models/e.gguf');
    expect(argValue(args, '--port')).toBe('8099');
  });
});

describe('embeddingModelMatches', () => {
  it('matches equivalent normalized model paths', () => {
    expect(embeddingModelMatches('/models/../models/embed.gguf', '/models/embed.gguf')).toBe(true);
  });

  it('rejects a server running a different embedding model', () => {
    expect(embeddingModelMatches('/models/other.gguf', '/models/embed.gguf')).toBe(false);
  });
});
