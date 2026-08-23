import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedRuntimeRegistry, sharedRuntimeKey } from '../../src/backend/SharedRuntimeRegistry';
import type { ModelConfig } from '../../src/config/types';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function registry(isAlive?: (pid: number) => boolean): SharedRuntimeRegistry {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shared-runtime-'));
  roots.push(root);
  return isAlive ? new SharedRuntimeRegistry(root, isAlive) : new SharedRuntimeRegistry(root);
}

/** The lease directory the registry writes into, for direct manipulation. */
function leaseDir(reg: SharedRuntimeRegistry, key: string): string {
  const root = (reg as unknown as { root: string }).root;
  return path.join(root, `${key}.leases`);
}

describe('SharedRuntimeRegistry', () => {
  it('publishes a compatible runtime and tracks independent borrower leases', () => {
    const current = registry();
    const key = sharedRuntimeKey(model({ gguf_path: 'N:/models/gemma.gguf' }), {});
    current.publish({ key, model: 'gemma', endpoint: 'http://127.0.0.1:8080', ownerPid: process.pid, createdAt: 'now' });
    expect(current.find(key)?.endpoint).toBe('http://127.0.0.1:8080');
    current.acquireLease(key, 'workspace-a');
    current.acquireLease(key, 'workspace-b');
    expect(current.hasBorrowers(key)).toBe(true);
    current.releaseLease(key, 'workspace-a');
    expect(current.hasBorrowers(key)).toBe(true);
    current.releaseLease(key, 'workspace-b');
    expect(current.hasBorrowers(key)).toBe(false);
  });

  it('reclaims the lease of a borrower that died without releasing it', () => {
    const dead = registry(() => false);
    const key = 'k';
    dead.acquireLease(key, 'crashed-window');
    expect(dead.hasBorrowers(key)).toBe(false);
    expect(fs.readdirSync(leaseDir(dead, key))).toEqual([]);
  });

  it('keeps a live borrower and reclaims only the dead one', () => {
    const mixed = registry((pid) => pid === 1);
    const key = 'k';
    fs.mkdirSync(leaseDir(mixed, key), { recursive: true });
    fs.writeFileSync(path.join(leaseDir(mixed, key), 'live.json'), JSON.stringify({ pid: 1 }));
    fs.writeFileSync(path.join(leaseDir(mixed, key), 'dead.json'), JSON.stringify({ pid: 2 }));
    expect(mixed.hasBorrowers(key)).toBe(true);
    expect(fs.readdirSync(leaseDir(mixed, key))).toEqual(['live.json']);
  });

  it('discards a malformed lease instead of blocking the owner forever', () => {
    const broken = registry(() => true);
    const key = 'k';
    fs.mkdirSync(leaseDir(broken, key), { recursive: true });
    fs.writeFileSync(path.join(leaseDir(broken, key), 'bad.json'), '{not json');
    fs.writeFileSync(path.join(leaseDir(broken, key), 'nopid.json'), JSON.stringify({ x: 1 }));
    expect(broken.hasBorrowers(key)).toBe(false);
    expect(fs.readdirSync(leaseDir(broken, key))).toEqual([]);
  });

  it('reports no borrowers when the lease directory does not exist', () => {
    expect(registry().hasBorrowers('never-published')).toBe(false);
  });

  it('records the borrower pid so a foreign window can judge liveness', () => {
    const current = registry();
    current.acquireLease('k', 'me');
    const file = path.join(leaseDir(current, 'k'), 'me.json');
    const lease = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; createdAt: string };
    expect(lease.pid).toBe(process.pid);
    expect(Date.parse(lease.createdAt)).not.toBeNaN();
  });
});

/** A minimal llama.cpp model; overrides pick the field under test. */
function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'gemma',
    provider: 'llama.cpp',
    gguf_path: 'N:/models/gemma.gguf',
    ...overrides,
  } as ModelConfig;
}

describe('sharedRuntimeKey', () => {
  it('ignores request-only fields that do not change the spawned server', () => {
    const base = sharedRuntimeKey(model(), {});
    expect(sharedRuntimeKey(model({ temperature: 0.9 } as Partial<ModelConfig>), {})).toBe(base);
    expect(sharedRuntimeKey(model({ system_prompt: 'be terse' }), {})).toBe(base);
  });

  it('forks identity on every server-affecting setting', () => {
    const base = sharedRuntimeKey(model(), {});
    expect(sharedRuntimeKey(model({ n_gpu_layers: 10 }), {})).not.toBe(base);
    expect(sharedRuntimeKey(model({ num_ctx: 65536 }), {})).not.toBe(base);
    expect(sharedRuntimeKey(model({ type_k: 'f16' }), {})).not.toBe(base);
    // --threads lives on the server config and was missing from the old key
    expect(sharedRuntimeKey(model(), { n_threads: 8 })).not.toBe(base);
  });

  it('treats extra server args as ordered, never sorted', () => {
    const a = sharedRuntimeKey(model({ extra_llama_server_args: ['--foo', '1', '--bar', '2'] }), {});
    const b = sharedRuntimeKey(model({ extra_llama_server_args: ['--bar', '2', '--foo', '1'] }), {});
    // llama.cpp honours later-option precedence, so order is meaning.
    expect(a).not.toBe(b);
  });

  it('is stable across separator and redundant-segment differences in the path', () => {
    const a = sharedRuntimeKey(model({ gguf_path: 'N:/models/gemma.gguf' }), {});
    const b = sharedRuntimeKey(model({ gguf_path: 'N:\\models\\sub\\..\\gemma.gguf' }), {});
    expect(a).toBe(b);
  });

  it.runIf(process.platform !== 'win32')(
    'keeps case-differing paths distinct on case-sensitive filesystems',
    () => {
      const a = sharedRuntimeKey(model({ gguf_path: '/models/Gemma.gguf' }), {});
      const b = sharedRuntimeKey(model({ gguf_path: '/models/gemma.gguf' }), {});
      expect(a).not.toBe(b);
    },
  );

  it('does not fork identity on host or port', () => {
    // Those identify the instance, not the runtime; the pool supplies its own.
    expect(sharedRuntimeKey(model(), { port: 9999 })).toBe(sharedRuntimeKey(model(), { port: 1 }));
  });
});
