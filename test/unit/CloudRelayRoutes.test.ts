import * as http from 'http';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireCloudRelay } from '../../src/llm/CloudRelayServer';
import type { ForgeConfig } from '../../src/config/types';
import { findFreeLoopbackPort, listenLoopback } from '../support/listenLoopback';

async function listen(server: http.Server): Promise<number> {
  return listenLoopback(server);
}

async function freePort(): Promise<number> {
  return findFreeLoopbackPort();
}

describe('CloudRelayRoutes', () => {
  let relay: ReturnType<typeof wireCloudRelay> | undefined;
  let upstream: http.Server | undefined;
  afterEach(async () => {
    relay?.dispose();
    relay = undefined;
    if (upstream?.listening) await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    upstream = undefined;
  });

  it('allowlists cloud Ollama chat, answers release locally, and exposes no management routes', async () => {
    let upstreamCalls = 0;
    upstream = http.createServer((req, res) => {
      upstreamCalls += 1;
      if (req.url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.end('{"message":{"content":"ok"},"done":true}\n');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const upstreamPort = await listen(upstream);
    const port = await freePort();
    const config = {
      models: [
        { name: 'qwen-cloud:cloud', provider: 'ollama', endpoint: `http://127.0.0.1:${upstreamPort}` },
        { name: 'gemma4:31b-cloud', provider: 'ollama', endpoint: `http://127.0.0.1:${upstreamPort}` },
        { name: 'qwen-local', provider: 'ollama', endpoint: `http://127.0.0.1:${upstreamPort}` },
      ],
      cloud_relay: {
        enabled: true,
        port,
        max_body_mb: 1,
        models: ['qwen-cloud:cloud', 'gemma4:31b-cloud', 'qwen-local'],
      },
    } as unknown as ForgeConfig;
    const extensionContext = { secrets: { get: vi.fn() } } as unknown as vscode.ExtensionContext;
    relay = wireCloudRelay(extensionContext, () => config);
    const base = `http://127.0.0.1:${port}`;

    const listing = await fetch(`${base}/v1/models`);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toEqual({
      object: 'list',
      data: [
        { id: 'qwen-cloud:cloud', owned_by: 'forge-relay', kind: 'ollama' },
        { id: 'gemma4:31b-cloud', owned_by: 'forge-relay', kind: 'ollama' },
      ],
    });

    const denied = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-allowlisted' }),
    });
    expect(denied.status).toBe(404);
    const missingModel = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 42 }),
    });
    expect(missingModel.status).toBe(400);
    const notCloud = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-local' }),
    });
    expect(notCloud.status).toBe(404);

    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-cloud:cloud', messages: [] }),
    });
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain('"done":true');
    expect(upstreamCalls).toBe(1);

    // Ollama names some cloud models with a `-cloud` tag suffix, not `:cloud`.
    const dashCloud = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemma4:31b-cloud', messages: [] }),
    });
    expect(dashCloud.status).toBe(200);
    expect(upstreamCalls).toBe(2);

    const release = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-cloud:cloud', keep_alive: 0 }),
    });
    expect(release.status).toBe(200);
    expect(upstreamCalls).toBe(2);
    const invalidRelease = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-cloud:cloud', keep_alive: 10 }),
    });
    expect(invalidRelease.status).toBe(400);

    for (const route of ['/api/pull', '/api/delete', '/api/tags']) {
      const response = await fetch(`${base}${route}`, { method: 'POST' });
      expect(response.status, route).toBe(404);
    }
    expect(extensionContext.secrets.get).not.toHaveBeenCalled();
  });

  /**
   * A name left in `cloud_relay.models` after its model was deleted is no
   * longer a config error, so the relay has to say what it means at request
   * time: "you may not ask for this" and "this no longer exists on the
   * desktop" are different fixes, and the laptop cannot tell them apart from
   * the generic refusal. The name is also absent from `GET /v1/models`, so the
   * laptop's picker does not offer it.
   */
  it('refuses a stale allowlist name with the reason, not just the refusal', async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const port = await freePort();
    const config = {
      models: [
        { name: 'qwen-cloud:cloud', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' },
      ],
      cloud_relay: {
        enabled: true,
        port,
        max_body_mb: 1,
        models: ['qwen-cloud:cloud', 'gemma4:31b-cloud'],
      },
    } as unknown as ForgeConfig;
    relay = wireCloudRelay({ secrets: { get: vi.fn() } } as unknown as vscode.ExtensionContext, () => config);
    const base = `http://127.0.0.1:${port}`;

    const listing = await fetch(`${base}/v1/models`);
    expect(await listing.json()).toEqual({
      object: 'list',
      data: [{ id: 'qwen-cloud:cloud', owned_by: 'forge-relay', kind: 'ollama' }],
    });

    const stale = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemma4:31b-cloud' }),
    });
    expect(stale.status).toBe(404);
    const staleBody = (await stale.json()) as { error: { message: string } };
    expect(staleBody.error.message).toContain('not allowlisted');
    expect(staleBody.error.message).toContain('no longer configured on the desktop');

    const neverListed = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'some-other-model' }),
    });
    expect(neverListed.status).toBe(404);
    const neverBody = (await neverListed.json()) as { error: { message: string } };
    expect(neverBody.error.message).not.toContain('no longer configured');
  });

  it('aborts an in-flight provider stream when config disables the relay', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"message":{"content":"first"}}\n');
      res.once('close', upstreamClosed);
      const timer = setTimeout(() => res.end('{"done":true}\n'), 30_000);
      res.once('close', () => clearTimeout(timer));
    });
    const upstreamPort = await listen(upstream);
    const port = await freePort();
    const config = {
      models: [{ name: 'cloud:cloud', provider: 'ollama', endpoint: `http://127.0.0.1:${upstreamPort}` }],
      cloud_relay: { enabled: true, port, max_body_mb: 1, models: ['cloud:cloud'] },
    } as unknown as ForgeConfig;
    relay = wireCloudRelay(
      { secrets: { get: vi.fn() } } as unknown as vscode.ExtensionContext,
      () => config,
    );
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cloud:cloud', messages: [] }),
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    config.cloud_relay!.enabled = false;
    relay.applyConfig();
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream remained open')), 1000)),
    ]);
    expect((await reader.read()).done).toBe(true);
  });
});
