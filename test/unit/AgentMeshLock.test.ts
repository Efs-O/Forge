import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UNREADABLE_LOCK_GRACE_MS, acquireLock, releaseLock } from '../../src/agentMesh/lock';
import type { HostId, HostLivenessDeps } from '../../src/agentMesh/hostIdentity';

/**
 * Regressions for audit A5 (2026-09-21): an empty or corrupt mesh lock used
 * to block every later alias/exchange-log operation until repaired by hand.
 */

let dir: string;
let lockPath: string;
const me: HostId = { pid: 111, startedAt: 1 };
const other: HostId = { pid: 222, startedAt: 2 };
const allAlive: HostLivenessDeps = { isHostAlive: () => true };
const allDead: HostLivenessDeps = { isHostAlive: () => false };

/** Backdate the lock so it is past the unreadable grace. */
function age(file: string, ms: number): void {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
}

const record = (): unknown => JSON.parse(fs.readFileSync(lockPath, 'utf8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mesh-lock-'));
  lockPath = path.join(dir, 'exchanges.lock');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mesh lock recovery (audit A5)', () => {
  it('publishes a complete record and leaves no temporaries behind', () => {
    acquireLock(lockPath, me, allAlive, Date.now() + 100);
    expect(record()).toEqual({ host_pid: 111, host_started_at: 1 });
    expect(fs.readdirSync(dir)).toEqual(['exchanges.lock']);
    releaseLock(lockPath, me);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('reclaims an empty lock left by a crash between create and write', () => {
    fs.writeFileSync(lockPath, '');
    age(lockPath, UNREADABLE_LOCK_GRACE_MS + 1_000);
    acquireLock(lockPath, me, allAlive, Date.now() + 100);
    expect(record()).toEqual({ host_pid: 111, host_started_at: 1 });
  });

  it('reclaims a lock holding partial JSON once it is past the grace', () => {
    fs.writeFileSync(lockPath, '{"host_pid": 22');
    age(lockPath, UNREADABLE_LOCK_GRACE_MS + 1_000);
    acquireLock(lockPath, me, allAlive, Date.now() + 100);
    expect(record()).toEqual({ host_pid: 111, host_started_at: 1 });
  });

  it('does not steal a fresh unreadable lock a legacy creator may still be writing', () => {
    fs.writeFileSync(lockPath, '');
    expect(() => acquireLock(lockPath, me, allAlive, Date.now() + 60)).toThrow('unreadable record');
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('');
  });

  it('still waits on a live holder, and reclaims a dead one', () => {
    fs.writeFileSync(lockPath, JSON.stringify({ host_pid: 222, host_started_at: 2 }));
    expect(() => acquireLock(lockPath, me, allAlive, Date.now() + 60)).toThrow('live host pid 222');
    acquireLock(lockPath, me, allDead, Date.now() + 100);
    expect(record()).toEqual({ host_pid: 111, host_started_at: 1 });
    releaseLock(lockPath, other); // not ours: left alone
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('serializes real processes contending for an orphaned lock', async () => {
    fs.writeFileSync(lockPath, '');
    age(lockPath, UNREADABLE_LOCK_GRACE_MS + 1_000);
    const counter = path.join(dir, 'counter.txt');
    const bundle = path.join(dir, 'lock.cjs');
    buildSync({
      entryPoints: [path.resolve('src/agentMesh/lock.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      logLevel: 'error',
    });
    fs.writeFileSync(counter, '0');
    // Each worker takes the lock through the real module and does a
    // read-modify-write; a lost update means two held the lock at once.
    const worker = `
      const fs = require('fs');
      const { acquireLock, releaseLock } = require(${JSON.stringify(bundle)});
      const me = { pid: process.pid, startedAt: 1 };
      for (let i = 0; i < 20; i++) {
        acquireLock(${JSON.stringify(lockPath)}, me, { isHostAlive: () => true }, Date.now() + 10000);
        const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
        fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
        releaseLock(${JSON.stringify(lockPath)}, me);
      }`;
    const runs = [0, 1, 2].map(
      () =>
        new Promise<number>((resolve, reject) => {
          const child = spawn(process.execPath, ['-e', worker], { stdio: 'inherit' });
          child.on('error', reject);
          child.on('exit', (code) => resolve(code ?? -1));
        }),
    );
    expect(await Promise.all(runs)).toEqual([0, 0, 0]);
    expect(fs.readFileSync(counter, 'utf8')).toBe('60');
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(['counter.txt', 'lock.cjs']);
  }, 30_000);
});
