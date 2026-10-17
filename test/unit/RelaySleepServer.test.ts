import { createHmac } from 'crypto';
import { createServer, request as httpRequest } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import { RELAY_SLEEP_SECRET, RelaySleepServer } from '../../src/remote/RelaySleepServer';

const suspension = vi.hoisted(() => ({ suspend: vi.fn<() => Promise<void>>() }));

vi.mock('../../src/system/PowerControl', () => ({
  PowerControl: class {
    suspend = suspension.suspend;
  },
}));

interface LocalResponse {
  status: number;
  body: string;
}

interface RelayHandle {
  port: number;
  status: ReturnType<typeof vi.fn>;
}

const secret = 'test-relay-secret';
const body = '{"action":"sleep"}';
const relays: RelaySleepServer[] = [];

async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function startRelay(relayIp = '127.0.0.1'): Promise<RelayHandle> {
  const port = await freeLoopbackPort();
  const status = vi.fn(() => ({
    streamingConversationIds: [] as string[],
    requestChains: [] as unknown[],
    pendingApproval: false,
  }));
  const relay = new RelaySleepServer();
  relays.push(relay);
  await relay.start({
    host: '127.0.0.1',
    port,
    relayIp,
    secrets: {
      get: async (key: string) => (key === RELAY_SLEEP_SECRET ? secret : undefined),
    } as unknown as vscode.SecretStorage,
    forge: { status } as unknown as ForgeHostFacade,
    notify: vi.fn(),
  });
  return { port, status };
}

function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<LocalResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/v1/sleep',
        headers: options.headers,
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: responseBody });
        });
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

function signedHeaders(nonce: string, text = body): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${text}`)
    .digest('hex');
  return {
    'x-forge-relay-timestamp': timestamp,
    'x-forge-relay-nonce': nonce,
    'x-forge-relay-signature': signature,
  };
}

afterEach(async () => {
  for (const relay of relays.splice(0)) relay.dispose();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

beforeEach(() => {
  suspension.suspend.mockReset().mockResolvedValue(undefined);
});

describe('RelaySleepServer security boundary', () => {
  it('accepts only POST /v1/sleep from the configured relay address', async () => {
    const { port } = await startRelay();

    await expect(send(port, { method: 'GET' })).resolves.toMatchObject({ status: 404 });
    await expect(
      send(port, { path: '/other', headers: signedHeaders('method-path-nonce-1'), body }),
    ).resolves.toMatchObject({ status: 404 });

    const wrongRelay = await startRelay('127.0.0.2');
    await expect(
      send(wrongRelay.port, {
        headers: signedHeaders('wrong-relay-nonce-1'),
        body,
      }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it('checks HMAC authentication and rejects replayed nonces', async () => {
    const { port } = await startRelay();
    const nonce = 'valid-relay-nonce-0001';
    const invalid = signedHeaders('invalid-relay-nonce-001');
    invalid['x-forge-relay-signature'] = '0'.repeat(64);

    await expect(send(port, { headers: invalid, body })).resolves.toMatchObject({
      status: 401,
    });

    const headers = signedHeaders(nonce);
    await expect(send(port, { headers, body })).resolves.toMatchObject({ status: 202 });
    await expect(send(port, { headers, body })).resolves.toMatchObject({ status: 401 });
  });

  it('refuses sleep while Forge is busy and stubs power suspension on acceptance', async () => {
    const { port, status } = await startRelay();
    status.mockReturnValue({
      streamingConversationIds: ['conversation'],
      requestChains: [],
      pendingApproval: false,
    });
    await expect(
      send(port, { headers: signedHeaders('busy-relay-nonce-0001'), body }),
    ).resolves.toMatchObject({ status: 409 });
    expect(suspension.suspend).not.toHaveBeenCalled();

    status.mockReturnValue({
      streamingConversationIds: [],
      requestChains: [],
      pendingApproval: false,
    });
    await expect(
      send(port, { headers: signedHeaders('idle-relay-nonce-00001'), body }),
    ).resolves.toMatchObject({ status: 202 });
  });
});
