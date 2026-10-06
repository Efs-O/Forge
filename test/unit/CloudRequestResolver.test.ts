import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/backend/ExternalModelServers', () => ({
  beforeExternalRequest: vi.fn(async () => undefined),
}));

import type * as vscode from 'vscode';
import type { ModelConfig } from '../../src/config/types';
import { ForgeConfigSchema } from '../../src/config/schema';
import { resolveCloudRequestTarget } from '../../src/llm/CloudRequestResolver';

const secrets = (value: string | undefined) =>
  ({ get: vi.fn(async () => value) }) as unknown as vscode.SecretStorage;

const local = {
  name: 'strata',
  provider: 'openai-compatible',
  endpoint: 'http://127.0.0.1:8090',
  model: 'qwen',
} as ModelConfig;

describe('resolveCloudRequestTarget', () => {
  it('sends no key to an openai-compatible server configured without one', async () => {
    const target = await resolveCloudRequestTarget(local, secrets(undefined));
    expect(target.apiKey).toBe('');
  });

  it('still refuses a configured key that is missing from SecretStorage', async () => {
    await expect(
      resolveCloudRequestTarget({ ...local, api_key_secret: 'strata' }, secrets(undefined)),
    ).rejects.toThrow('no bearer token in SecretStorage');
  });

  it('accepts a keyless openai-compatible model but still requires a key for openrouter', () => {
    const config = (model: Record<string, unknown>) =>
      ForgeConfigSchema.safeParse({ active_model: 'm', models: [{ name: 'm', ...model }] });
    expect(
      config({ provider: 'openai-compatible', endpoint: 'http://127.0.0.1:8090', model: 'q' })
        .success,
    ).toBe(true);
    expect(config({ provider: 'openrouter', model: 'q' }).success).toBe(false);
  });
});
