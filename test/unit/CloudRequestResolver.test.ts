import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/backend/ExternalModelServers', () => ({
  beforeExternalRequest: vi.fn(async () => undefined),
}));

import type * as vscode from 'vscode';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import { ForgeConfigSchema } from '../../src/config/schema';
import { beforeExternalRequest } from '../../src/backend/ExternalModelServers';
import { RemoteStarterClient, setRemoteStarterClient } from '../../src/llm/RemoteStarterClient';
import { resolveCloudRequestTarget } from '../../src/llm/CloudRequestResolver';
import { PER_COMPUTER_SECRET_HINT } from '../../src/util/secretHint';

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
    const message = await resolveCloudRequestTarget(
      { ...local, api_key_secret: 'strata' },
      secrets(undefined),
    ).then(
      () => undefined,
      (err: unknown) => (err as Error).message,
    );
    expect(message).toContain('no bearer token in SecretStorage');
    // A VS Code Remote window reads the keychain of the machine being typed on,
    // so "no key here" is the wrong thing to conclude from an empty laptop.
    expect(message).toContain(PER_COMPUTER_SECRET_HINT);
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

/**
 * The `remote_start` half of the resolver (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md
 * Phase 2). Two things have to be true here that a unit test of the starter
 * client alone cannot prove: the port in the answer replaces the guessed one,
 * and `beforeExternalRequest` is NOT reached — that hook unloads the other
 * desktop entries on a machine that manages them, and this window manages none
 * of them, so calling it would try to stop a server on another machine.
 */
describe('resolveCloudRequestTarget for remote_start models', () => {
  afterEach(() => setRemoteStarterClient(undefined));

  const remote = {
    name: 'strata-laptop',
    provider: 'openai-compatible',
    endpoint: 'http://100.64.0.10:8090',
    model: 'qwen',
    remote_start: { starter: 'http://100.64.0.10:8798', model: 'strata-flashnext-iq3s' },
  } as ModelConfig;

  /** A desktop starter that answers `/ensure` with the port it is really
   *  answering on, and records what it was asked for. It honours the signal the
   *  way `fetch` does — rejecting with an AbortError before any byte is sent —
   *  so a test can tell a cancelled request from one that was never made.
   */
  function fakeStarter(answer: Record<string, unknown>) {
    const asked: { url: string; body: string; aborted: boolean }[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      const aborted = !!init?.signal?.aborted;
      asked.push({
        url: String(url),
        body: String(init?.body ?? ''),
        aborted,
      });
      if (aborted) throw new DOMException('This operation was aborted', 'AbortError');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(answer),
      } as unknown as Response;
    };
    return { asked, fetchImpl: fetchImpl as unknown as typeof fetch };
  }

  const clientWith = (fetchImpl: typeof fetch) =>
    setRemoteStarterClient(
      new RemoteStarterClient(
        () => ({ models: [remote] }) as unknown as ForgeConfig,
        () => false,
        () => Date.now(),
        fetchImpl,
      ),
    );

  it('uses the port the desktop reports and never calls the local request hook', async () => {
    vi.clearAllMocks();
    const { asked, fetchImpl } = fakeStarter({
      port: 8082,
      leaseId: 'l',
      expiresAt: Date.now() + 600_000,
    });
    clientWith(fetchImpl);

    const target = await resolveCloudRequestTarget(remote, secrets(undefined));
    // The host is the laptop's, the port is the desktop's: the 8090 in the
    // config was a guess, and a llama.cpp slot could have landed on any 808x.
    expect(target.baseUrl).toBe('http://100.64.0.10:8082');
    expect(target.apiKey).toBe('');
    expect(beforeExternalRequest).not.toHaveBeenCalled();
    expect(asked[0]!.url).toBe('http://100.64.0.10:8798/ensure');
    // The DESKTOP's model name, not this machine's.
    expect(JSON.parse(asked[0]!.body)).toMatchObject({ model: 'strata-flashnext-iq3s' });
  });

  it('still resolves a configured key, and still asks the starter for the port', async () => {
    vi.clearAllMocks();
    const { fetchImpl } = fakeStarter({ port: 8091, leaseId: 'l', expiresAt: Date.now() + 600_000 });
    clientWith(fetchImpl);

    const target = await resolveCloudRequestTarget(
      { ...remote, api_key_secret: 'lmstudio' },
      secrets('lmstudio-key'),
    );
    expect(target.apiKey).toBe('lmstudio-key');
    expect(target.baseUrl).toBe('http://100.64.0.10:8091');
    expect(beforeExternalRequest).not.toHaveBeenCalled();
  });

  it('threads the cancel signal into the ensure, so a Stop cuts the wait', async () => {
    vi.clearAllMocks();
    const { asked, fetchImpl } = fakeStarter({ port: 8090, expiresAt: Date.now() + 600_000 });
    clientWith(fetchImpl);
    const ctrl = new AbortController();
    ctrl.abort();

    // The desktop may take 300 s to cold-start a quant; Stop has to cut that
    // wait short rather than wait for the starter to answer. The request that
    // IS made must already carry the cancelled signal, so no round trip happens.
    await expect(
      resolveCloudRequestTarget(remote, secrets(undefined), ctrl.signal),
    ).rejects.toThrow(/abort/i);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.aborted).toBe(true);
    expect(beforeExternalRequest).not.toHaveBeenCalled();
  });
});
