/**
 * What these cover: a key-based cloud model in a VS Code Remote window has to be
 * served by the desktop's cloud relay, because that window's SecretStorage is
 * the keychain of the machine being typed on and holds no key. Before this rule
 * existed, such a model failed there with "no bearer token in SecretStorage" —
 * advice that sends the user to the wrong computer — even though the desktop's
 * own Forge window had the key, the model and the GPU.
 *
 * This is the CI-enforceable row of `docs/plans/LAPTOP_HEAD_PLAN.md`'s ledger for
 * laptop keys: test 1 asserts that a remote window NEVER reads SecretStorage for
 * a key-based chat model, so a later caller that does fails it. Test 2 is the
 * same model in a local window, which keeps test 1 from passing for the wrong
 * reason.
 *
 * Which remote kinds count as remote is `vscode/remoteWindowKind.ts`'s decision,
 * so every test here drives activation through it: `tunnel` and `ssh-remote` are
 * the hosted side, and `wsl` or a container window is this computer's own — its
 * keychain holds the key, so it must still read it and call the provider itself.
 *
 * The stub server stands in for the desktop relay: `GET /v1/models` answers with
 * the ids `CloudRelayServer` would serve, on an ephemeral loopback port that the
 * config names as `cloud_relay.port`.
 */

import * as http from 'http';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import { resolveCloudRequestTarget } from '../../src/llm/CloudRequestResolver';
import { configureRemoteWindowRoute } from '../../src/llm/RemoteWindowRoute';
import { thisWindowHostedElsewhere } from '../../src/vscode/remoteWindowKind';
import { findFreeLoopbackPort, listenLoopback } from '../support/listenLoopback';

const grok = {
  name: 'grok',
  provider: 'xai',
  api_key_secret: 'forge.xai',
} as ModelConfig;

/** `vscode.env` is read-only in @types/vscode; the test alias is a plain object. */
const env = vscode.env as { remoteName?: string };

/**
 * Activation calls `configureRemoteWindowRoute(thisWindowHostedElsewhere(), …)`,
 * so driving the tests through the same seam covers the remote-kind decision and
 * the route in one go: `ssh-remote` must land on `tunnel`'s side of it, and a
 * WSL, container or Codespaces window must land on the local side.
 */
function activateForWindow(kind: string | undefined, getConfig: () => ForgeConfig): void {
  env.remoteName = kind;
  configureRemoteWindowRoute(thisWindowHostedElsewhere(), getConfig);
}

/** A laptop keychain that DOES hold a key: if the window still read it, the
 *  request would go to the provider with a key that belongs to nobody. */
function laptopSecrets(value = 'a-key-that-should-never-be-read') {
  const get = vi.fn(async () => value);
  return { get, storage: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
}

function configWithRelay(port: number, relayModels: string[] = ['grok']): ForgeConfig {
  return ForgeConfigSchema.parse({
    active_model: 'grok',
    // Two models, because the relay's allowlist is checked against the config by
    // `validateCloudRelayConfig`: a test that allowlists a model the config does
    // not have fails at parse time, not at the request.
    models: [
      { name: 'grok', provider: 'xai', api_key_secret: 'forge.xai' },
      {
        name: 'cerebras',
        provider: 'openai-compatible',
        endpoint: 'https://api.cerebras.ai',
        api_key_secret: 'forge.cerebras',
      },
    ],
    cloud_relay: { enabled: true, port, models: relayModels },
  });
}

interface StubRelay {
  port: number;
  requests: string[];
  close(): Promise<void>;
}

const stubs: StubRelay[] = [];

async function startStubRelay(
  options: { ids?: string[]; slowMs?: number; status?: number } = {},
): Promise<StubRelay> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.on('error', () => undefined); // the client may hang up first, as a cancelled probe does
    const answer = (): void => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(options.status ?? 200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: (options.ids ?? []).map((id) => ({
            id,
            owned_by: 'forge-relay',
            kind: 'openai',
          })),
        }),
      );
    };
    if (options.slowMs) setTimeout(answer, options.slowMs).unref();
    else answer();
  });
  const port = await listenLoopback(server);
  const stub: StubRelay = {
    port,
    requests,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
  stubs.push(stub);
  return stub;
}

/** A port that was bound and then let go: what a closed desktop window leaves. */
async function freePort(): Promise<number> {
  return findFreeLoopbackPort();
}

afterEach(async () => {
  env.remoteName = undefined;
  // A local window, which is the state activation sets when nothing hosts it.
  configureRemoteWindowRoute(false, () => configWithRelay(8797));
  for (const stub of stubs.splice(0)) await stub.close();
});

describe('a key-based cloud model in a VS Code Remote window', () => {
  it('goes to the desktop relay and reads no key at all', async () => {
    const stub = await startStubRelay({ ids: ['grok'] });
    activateForWindow('tunnel', () => configWithRelay(stub.port));
    const secrets = laptopSecrets();

    const target = await resolveCloudRequestTarget(grok, secrets as unknown as vscode.SecretStorage);

    expect(target).toEqual({ baseUrl: `http://127.0.0.1:${stub.port}`, apiKey: '' });
    expect(stub.requests).toContain('GET /v1/models');
    // The guarantee: the laptop's keychain was never opened for this request.
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it('an ssh-remote window behaves exactly like a tunnel window', async () => {
    const stub = await startStubRelay({ ids: ['grok'] });
    activateForWindow('ssh-remote', () => configWithRelay(stub.port));
    const secrets = laptopSecrets();

    const target = await resolveCloudRequestTarget(
      grok,
      secrets as unknown as vscode.SecretStorage,
    );

    expect(target).toEqual({ baseUrl: `http://127.0.0.1:${stub.port}`, apiKey: '' });
    expect(stub.requests).toContain('GET /v1/models');
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it('a local window still reads the key and calls the provider itself', async () => {
    const stub = await startStubRelay({ ids: ['grok'] });
    activateForWindow(undefined, () => configWithRelay(stub.port));
    const secrets = laptopSecrets('the-desktop-key');

    const target = await resolveCloudRequestTarget(grok, secrets as unknown as vscode.SecretStorage);

    expect(target).toEqual({ baseUrl: 'https://api.x.ai', apiKey: 'the-desktop-key' });
    expect(secrets.get).toHaveBeenCalledWith('forge.xai');
    expect(stub.requests).toEqual([]);
  });

  it('says the relay is off when the desktop has it off', async () => {
    const stub = await startStubRelay({ ids: ['grok'] });
    activateForWindow('tunnel', () => ({
      ...configWithRelay(stub.port),
      cloud_relay: { enabled: false, port: stub.port, models: ['grok'] },
    }));
    const secrets = laptopSecrets();

    await expect(
      resolveCloudRequestTarget(grok, secrets as unknown as vscode.SecretStorage),
    ).rejects.toThrow(
      "key-based cloud models go through the desktop's cloud relay, which is off",
    );
    expect(secrets.get).not.toHaveBeenCalled();
    expect(stub.requests).toEqual([]);
  });

  it('names the model and cloud_relay.models when the desktop does not allowlist it', async () => {
    const stub = await startStubRelay({ ids: ['cerebras'] });
    // The laptop's own config allowlists `cerebras` only, and asks for `grok`.
    activateForWindow('tunnel', () => configWithRelay(stub.port, ['cerebras']));

    await expect(
      resolveCloudRequestTarget(grok, laptopSecrets() as unknown as vscode.SecretStorage),
    ).rejects.toThrow('"grok" is not in the desktop cloud relay');
    expect(stub.requests).toEqual([]); // not even probed
  });

  it('says no relay answers when the desktop window is not open', async () => {
    const port = await freePort();
    activateForWindow('tunnel', () => configWithRelay(port));

    await expect(
      resolveCloudRequestTarget(grok, laptopSecrets() as unknown as vscode.SecretStorage),
    ).rejects.toThrow(`no Forge cloud relay answers on 127.0.0.1:${port}`);
  });

  it('catches a desktop window still running an older config: a 200 without the model', async () => {
    const stub = await startStubRelay({ ids: ['cerebras'] });
    activateForWindow('tunnel', () => configWithRelay(stub.port));

    await expect(
      resolveCloudRequestTarget(grok, laptopSecrets() as unknown as vscode.SecretStorage),
    ).rejects.toThrow(/"grok" is not in the desktop cloud relay.*cerebras/s);
    expect(stub.requests).toContain('GET /v1/models');
  });

  it('refuses image generation, because the relay forwards chat only', async () => {
    const stub = await startStubRelay({ ids: ['grok'] });
    activateForWindow('tunnel', () => configWithRelay(stub.port));
    const secrets = laptopSecrets();

    await expect(
      resolveCloudRequestTarget(
        grok,
        secrets as unknown as vscode.SecretStorage,
        undefined,
        'image',
      ),
    ).rejects.toThrow(
      'image generation with a key-based provider is not available in a VS Code Remote window',
    );
    expect(secrets.get).not.toHaveBeenCalled();
    expect(stub.requests).toEqual([]);
  });
});

/**
 * The other side of `remoteWindowKind.ts`'s decision: a WSL, Dev Container,
 * attached container or Codespaces window is this computer's own, so its
 * keychain does hold the key and the window keeps the path it had before the
 * relay rule existed — read the key, dial the provider, never touch a relay.
 * Codespaces is here because its VM has no second Forge window to forward to.
 */
describe('a key-based cloud model in a window that is not hosted elsewhere', () => {
  it.each(['wsl', 'dev-container', 'attached-container', 'codespaces'])(
    'a %s window reads its key and calls the provider, exactly as a local window does',
    async (kind) => {
      const stub = await startStubRelay({ ids: ['grok'] });
      activateForWindow(kind, () => configWithRelay(stub.port));
      const secrets = laptopSecrets('the-key-on-this-computer');

      const target = await resolveCloudRequestTarget(
        grok,
        secrets as unknown as vscode.SecretStorage,
      );

      expect(target).toEqual({
        baseUrl: 'https://api.x.ai',
        apiKey: 'the-key-on-this-computer',
      });
      expect(secrets.get).toHaveBeenCalledWith('forge.xai');
      expect(stub.requests).toEqual([]);
    },
  );
});

/**
 * The cancel half: a Stop has to cut the probe rather than let the turn sit on a
 * relay that is not answering. The stub holds its answer, so a probe that
 * ignored the signal would succeed after 400 ms instead of failing at once.
 */
describe('a cancelled turn', () => {
  it('cuts the probe instead of waiting for the relay', async () => {
    const stub = await startStubRelay({ ids: ['grok'], slowMs: 400 });
    activateForWindow('tunnel', () => configWithRelay(stub.port));
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    await expect(
      resolveCloudRequestTarget(
        grok,
        laptopSecrets() as unknown as vscode.SecretStorage,
        controller.signal,
      ),
    ).rejects.toThrow(/abort/i);
    expect(Date.now() - started).toBeLessThan(400);
  });
});
