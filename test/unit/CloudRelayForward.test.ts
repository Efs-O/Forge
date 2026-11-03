import * as http from 'http';
import { randomBytes } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTailnetListener } from '../../src/backend/TailnetListener';
import { forwardCloudRequest } from '../../src/llm/CloudRelayForward';
import type { CloudRelayTargetResolver } from '../../src/llm/CloudRelayForward';
import type { ModelConfig } from '../../src/config/types';
import { findFreeLoopbackPort, listenLoopback } from '../support/listenLoopback';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const model: ModelConfig = { name: 'desktop-model', provider: 'openai-compatible' };
const secretInMemory = (): string => randomBytes(24).toString('hex');

async function listen(server: http.Server): Promise<number> {
  return listenLoopback(server);
}

describe('CloudRelayForward', () => {
  let relay: ReturnType<typeof createTailnetListener> | undefined;
  let upstream: http.Server | undefined;
  afterEach(async () => {
    relay?.dispose();
    relay = undefined;
    if (upstream?.listening) await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    upstream = undefined;
    vi.clearAllMocks();
  });

  async function startRelay(
    upstreamPort: number,
    key: string,
    resolver?: CloudRelayTargetResolver,
  ) {
    const port = await findFreeLoopbackPort();
    relay = createTailnetListener({
      port,
      routes: ['POST /v1/chat/completions'],
      maxBodyBytes: 1024 * 1024,
      label: 'CloudRelayTest',
      log,
      onRequest: (req, res, route, body) =>
        forwardCloudRequest({
          req,
          res,
          body,
          model,
          route,
          upstreamPath: '/v1/chat/completions',
          resolveTarget:
            resolver ??
            (async () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: key })),
          shutdownSignal: new AbortController().signal,
          logLine: (line) => log.info(line),
        }),
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const port = relay.boundAddress()?.port;
      if (port) return port;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('relay did not bind');
  }

  it('replaces Authorization, drops client credentials and X-* headers, rewrites model and streams bytes', async () => {
    const secret = secretInMemory();
    const laptopValue = secretInMemory();
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    let receivedBody = '';
    upstream = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (receivedBody += chunk));
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'set-cookie': 'ignored=1',
          'x-upstream-only': 'ignored',
        });
        res.write('data: first\n\n');
        setTimeout(() => res.end('data: second\n\n'), 10);
      });
    });
    const upstreamPort = await listen(upstream);
    const relayPort = await startRelay(upstreamPort, secret);
    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${laptopValue}`,
        cookie: `session=${laptopValue}`,
        'x-api-key': laptopValue,
        'x-forwarded-for': '192.0.2.1',
      },
      body: JSON.stringify({ model: 'laptop-alias', messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-upstream-only')).toBeNull();
    expect(await response.text()).toBe('data: first\n\ndata: second\n\n');
    expect(receivedHeaders?.authorization).toBe(`Bearer ${secret}`);
    expect(receivedHeaders?.cookie).toBeUndefined();
    expect(receivedHeaders?.['x-api-key']).toBeUndefined();
    expect(receivedHeaders?.['x-forwarded-for']).toBeUndefined();
    expect(JSON.parse(receivedBody)).toMatchObject({ model: 'desktop-model', messages: [] });
    const relayLines = log.info.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('[CloudRelay]'));
    expect(relayLines).toHaveLength(1);
    expect(relayLines[0]).not.toContain(secret);
  });

  it('redacts the resolved key from an upstream error body', async () => {
    const secret = secretInMemory();
    upstream = http.createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json', 'x-private': 'drop' });
      res.end(JSON.stringify({ error: `provider echoed ${secret}` }));
    });
    const upstreamPort = await listen(upstream);
    const relayPort = await startRelay(upstreamPort, secret);
    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'desktop-model' }),
    });
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(text).toContain('[redacted]');
    expect(text).not.toContain(secret);
    expect(response.headers.get('x-private')).toBeNull();
  });

  it('returns a resolver failure as 502 with the key name and no value', async () => {
    const secret = secretInMemory();
    let upstreamCalls = 0;
    upstream = http.createServer((_req, res) => {
      upstreamCalls += 1;
      res.end();
    });
    const upstreamPort = await listen(upstream);
    const relayPort = await startRelay(upstreamPort, secret, async () => {
      throw new Error('OpenRouter: no token in SecretStorage (key: test.secret.reference).');
    });
    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'desktop-model' }),
    });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).toContain('test.secret.reference');
    expect(text).not.toContain(secret);
    expect(upstreamCalls).toBe(0);
  });

  it('aborts the upstream when the laptop disconnects mid-stream', async () => {
    const upstreamClosed = new Promise<void>((resolve) => {
      upstream = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first\n\n');
        res.once('close', resolve);
        const timer = setTimeout(() => res.end('data: last\n\n'), 30_000);
        res.once('close', () => clearTimeout(timer));
      });
    });
    const upstreamPort = await listen(upstream!);
    const relayPort = await startRelay(upstreamPort, secretInMemory());
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'desktop-model' }),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not aborted')), 1000)),
    ]);
  });
});
