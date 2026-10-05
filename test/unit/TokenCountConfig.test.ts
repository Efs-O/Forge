import { describe, expect, it, vi, afterEach } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import { createCompactionCounter } from '../../src/sidebar/compactionCounter';
import type { IBackendPool } from '../../src/backend/BackendPool';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

afterEach(() => vi.unstubAllGlobals());

describe('token_count model config', () => {
  it('rejects count_tokens for Ollama with a field-specific issue', () => {
    const parsed = ForgeConfigSchema.safeParse({
      llama_server: {},
      models: [
        {
          name: 'm',
          provider: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          token_count: 'count_tokens',
        },
      ],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(JSON.stringify(parsed.error.issues)).toContain('token_count');
  });

  it('accepts count_tokens for openai-compatible', () => {
    const parsed = ForgeConfigSchema.safeParse({
      llama_server: {},
      models: [
        {
          name: 'm',
          provider: 'openai-compatible',
          endpoint: 'http://127.0.0.1:8090',
          api_key_secret: 'local',
          token_count: 'count_tokens',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('uses SecretStorage auth and the configured server model id', async () => {
    const config = ForgeConfigSchema.parse({
      active_model: 'strata-entry',
      llama_server: {},
      models: [
        {
          name: 'strata-entry',
          model: 'strata-server-id',
          provider: 'openai-compatible',
          endpoint: 'http://127.0.0.1:8090',
          api_key_secret: 'strata-key',
          token_count: 'count_tokens',
        },
      ],
    });
    let request: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        request = init;
        return { ok: true, status: 200, json: async () => ({ input_tokens: 9 }) };
      }),
    );
    const secrets = {
      get: vi.fn(async (key: string) => (key === 'strata-key' ? 'secret' : undefined)),
    };
    const counter = createCompactionCounter({
      getConfig: () => config,
      pool: {} as IBackendPool,
      secrets: secrets as never,
    });
    const conv: ConversationRuntime = {
      id: 'c1',
      title: 'test',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
      active_model: 'strata-entry',
    };

    expect(await counter.count('host block', conv)).toBe(9);
    expect(secrets.get).toHaveBeenCalledWith('strata-key');
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer secret');
    expect(JSON.parse(String(request?.body))).toMatchObject({ model: 'strata-server-id' });
  });
});
