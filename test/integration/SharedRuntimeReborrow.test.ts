/**
 * Re-borrowing must not leak the previous lease.
 *
 * Found on a real two-window run: window B borrowed, the owner's llama-server
 * was killed and respawned, B's backend went not-ready, and B's next prompt
 * borrowed again. The registry then held TWO leases naming B's (live) pid.
 *
 * That is worse than untidy. `releaseKey` only knows the CURRENT leaseId, so a
 * clean release in B leaves the earlier file behind — naming a process that is
 * still running. `hasBorrowers` therefore answers true forever and the OWNER
 * CAN NEVER UNLOAD while B stays open: the exact failure shared leases exist
 * to prevent, reintroduced through the re-borrow path.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackendPool } from '../../src/backend/BackendPool';
import { SharedRuntimeRegistry, sharedRuntimeKey } from '../../src/backend/SharedRuntimeRegistry';
import type { DirectBackend } from '../../src/backend/DirectBackend';
import type { ForgeConfig } from '../../src/config/types';

const GGUF = 'N:/models/shared.gguf';

function startFakeServer(): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: GGUF }] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ port: typeof address === 'object' && address ? address.port : 0, server });
    });
  });
}

describe('re-borrowing a shared runtime', () => {
  let root: string;
  let owner: Awaited<ReturnType<typeof startFakeServer>>;
  let cfg: ForgeConfig;
  let key: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reborrow-'));
    owner = await startFakeServer();
    cfg = {
      active_model: 'shared',
      llama_server: { binary: 'llama-server.exe', host: '127.0.0.1', port: owner.port },
      models: [{ name: 'shared', provider: 'llama.cpp', gguf_path: GGUF }],
      shared_runtime: { enabled: true },
    } as ForgeConfig;
    key = sharedRuntimeKey(cfg.models[0]!, cfg.llama_server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => owner.server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const leases = (): string[] => {
    try {
      return fs.readdirSync(path.join(root, `${key}.leases`));
    } catch {
      return [];
    }
  };

  /** Stand in for the owning window having published its server. */
  function publishOwner(registry: SharedRuntimeRegistry): void {
    registry.publish({
      key,
      model: 'shared',
      endpoint: `http://127.0.0.1:${owner.port}`,
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
    });
  }

  it('holds exactly one lease after borrowing the same runtime twice', async () => {
    const registry = new SharedRuntimeRegistry(root);
    publishOwner(registry);
    const pool = new BackendPool(cfg, registry);

    const first = (await pool.acquire('shared')) as DirectBackend;
    expect(leases()).toHaveLength(1);
    const firstLease = leases()[0]!;

    // The owner's server died and came back: the borrowed client is no longer
    // ready, but the slot record still exists. detach() reproduces exactly the
    // state the adopted-server monitor leaves behind.
    await first.detach();
    expect(first.isReady()).toBe(false);

    await pool.acquire('shared');

    // Before the fix this was 2 — the first lease was orphaned on disk.
    expect(leases()).toHaveLength(1);
    expect(leases()[0]).not.toBe(firstLease);
  });

  it('leaves the owner free to unload after a re-borrow then release', async () => {
    const registry = new SharedRuntimeRegistry(root);
    publishOwner(registry);
    const pool = new BackendPool(cfg, registry);

    const first = (await pool.acquire('shared')) as DirectBackend;
    await first.detach();
    await pool.acquire('shared');
    await pool.release('shared');

    // The decisive assertion. Every lease named THIS process, which is alive,
    // so a leaked one would keep hasBorrowers true and pin the owner forever.
    expect(leases()).toEqual([]);
    expect(registry.hasBorrowers(key)).toBe(false);
  });
});

/**
 * `stopAll` is the window-close / "Unload Model" path. For a BORROWED runtime
 * it must detach, never stop: the process belongs to another window.
 *
 * It previously called stop().catch(() => {}), which happened to be safe only
 * because stop() throws for an adopted server and the bare catch swallowed it.
 * Safety resting on a swallowed exception is one refactor away from killing
 * another window's llama-server, so this asserts the borrower path directly.
 */
describe('stopAll with a borrowed runtime', () => {
  let root: string;
  let owner: Awaited<ReturnType<typeof startFakeServer>>;
  let cfg: ForgeConfig;
  let key: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stopall-'));
    owner = await startFakeServer();
    cfg = {
      active_model: 'shared',
      llama_server: { binary: 'llama-server.exe', host: '127.0.0.1', port: owner.port },
      models: [{ name: 'shared', provider: 'llama.cpp', gguf_path: GGUF }],
      shared_runtime: { enabled: true },
    } as ForgeConfig;
    key = sharedRuntimeKey(cfg.models[0]!, cfg.llama_server);
  });

  afterEach(async () => {
    if (owner.server.listening) {
      await new Promise<void>((resolve) => owner.server.close(() => resolve()));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('detaches, releases the lease, and leaves the owner serving', async () => {
    const registry = new SharedRuntimeRegistry(root);
    registry.publish({
      key,
      model: 'shared',
      endpoint: `http://127.0.0.1:${owner.port}`,
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
    });
    const pool = new BackendPool(cfg, registry);
    const backend = (await pool.acquire('shared')) as DirectBackend;
    expect(fs.readdirSync(path.join(root, `${key}.leases`))).toHaveLength(1);

    await pool.stopAll();

    expect(fs.readdirSync(path.join(root, `${key}.leases`))).toEqual([]);
    expect(registry.hasBorrowers(key)).toBe(false);
    // Fully torn down, not the half-state stop()'s early throw used to leave.
    expect(backend.isReady()).toBe(false);
    expect(backend.loadedModel()).toBeNull();
    // The decisive assertion: the owner's server is untouched.
    expect(owner.server.listening).toBe(true);
    const probe = await fetch(`http://127.0.0.1:${owner.port}/v1/models`);
    expect(probe.ok).toBe(true);
  });
});
