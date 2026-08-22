/**
 * The shared-runtime scenarios that only appear with two Forge windows.
 *
 * A real HTTP server stands in for the owner's llama-server, so the adopt →
 * borrow → detach path runs for real: DirectBackend probes it, adopts it, and
 * must never terminate it. Lease files are real files under a temp root, and a
 * second SharedRuntimeRegistry instance is a second window.
 *
 * What is NOT covered here, and still needs two real VS Code windows: VRAM
 * behaviour, the llama-server process actually dying, and the sidebar UI.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirectBackend } from '../../src/backend/DirectBackend';
import { SharedRuntimeRegistry } from '../../src/backend/SharedRuntimeRegistry';
import type { ForgeConfig } from '../../src/config/types';

const GGUF = 'N:/models/shared.gguf';

/** An owner window's llama-server: healthy, and identifies the served GGUF. */
function startFakeServer(): Promise<{ port: number; server: http.Server; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: GGUF }] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, server, requests });
    });
  });
}

const closeServer = (server: http.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

function config(): ForgeConfig {
  return {
    active_model: 'shared',
    llama_server: { binary: 'llama-server.exe', host: '127.0.0.1', port: 8080 },
    models: [{ name: 'shared', provider: 'llama.cpp', gguf_path: GGUF }],
  } as ForgeConfig;
}

describe('shared runtime across two Forge windows', () => {
  let root: string;
  let owner: Awaited<ReturnType<typeof startFakeServer>>;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-multiwindow-'));
    owner = await startFakeServer();
  });

  afterEach(async () => {
    await closeServer(owner.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A borrowing window: adopts the owner's server and takes a lease. */
  async function borrow(leaseId: string, isAlive?: (pid: number) => boolean) {
    const registry = new SharedRuntimeRegistry(root, isAlive);
    const backend = new DirectBackend(config(), owner.port);
    await backend.hotSwap('shared');
    registry.acquireLease('runtime-key', leaseId);
    return { registry, backend };
  }

  it('borrows, then releases without killing the owner', async () => {
    const { registry, backend } = await borrow('window-b');
    expect(backend.isReady()).toBe(true);
    expect(registry.hasBorrowers('runtime-key')).toBe(true);

    await backend.detach();
    registry.releaseLease('runtime-key', 'window-b');

    expect(backend.isReady()).toBe(false);
    expect(registry.hasBorrowers('runtime-key')).toBe(false);
    // The decisive assertion: the owner's process is untouched and still serving.
    expect(owner.server.listening).toBe(true);
    const probe = await fetch(`http://127.0.0.1:${owner.port}/v1/models`);
    expect(probe.ok).toBe(true);
  });

  it('leaves no zombie ready state when the owner dies under a live borrower', async () => {
    const { backend } = await borrow('window-b');
    expect(backend.isReady()).toBe(true);

    await closeServer(owner.server);

    // The borrower must not keep claiming a usable endpoint once it is gone.
    // detach() is the client-side teardown and must work on a dead server.
    await backend.detach();
    expect(backend.isReady()).toBe(false);
    expect(backend.loadedModel()).toBeNull();
  });

  it('releases cleanly after the owner has already died, attempting no kill', async () => {
    const { registry, backend } = await borrow('window-b');
    await closeServer(owner.server);

    // stop() would throw "owned by another Forge window"; detach() is the path
    // a borrowed release takes, and it must resolve even with nothing there.
    await expect(backend.detach()).resolves.toBeUndefined();
    registry.releaseLease('runtime-key', 'window-b');
    expect(registry.hasBorrowers('runtime-key')).toBe(false);
  });

  it('keeps the owner protected by a surviving lease when one borrower dies', async () => {
    const livePid = process.pid;
    const deadPid = 2 ** 31 - 1;
    const b = new SharedRuntimeRegistry(root, (pid) => pid === livePid);

    // Two borrowers; write the dead one's lease as another window would have.
    b.acquireLease('runtime-key', 'window-b');
    fs.writeFileSync(
      path.join(root, 'runtime-key.leases', 'window-c.json'),
      JSON.stringify({ pid: deadPid }),
      'utf8',
    );
    expect(fs.readdirSync(path.join(root, 'runtime-key.leases'))).toHaveLength(2);

    // The owner asks whether it may unload.
    expect(b.hasBorrowers('runtime-key')).toBe(true);
    // Only the dead borrower's lease was reclaimed.
    expect(fs.readdirSync(path.join(root, 'runtime-key.leases'))).toEqual(['window-b.json']);

    // Once the last live borrower releases, the owner is free.
    b.releaseLease('runtime-key', 'window-b');
    expect(b.hasBorrowers('runtime-key')).toBe(false);
  });

  it('frees the owner once a crashed borrower is the only lease left', async () => {
    const crashed = new SharedRuntimeRegistry(root, () => false);
    crashed.acquireLease('runtime-key', 'window-b');

    // Owner-side check after the borrower window was force-killed.
    expect(crashed.hasBorrowers('runtime-key')).toBe(false);
    expect(fs.readdirSync(path.join(root, 'runtime-key.leases'))).toEqual([]);
  });
});
