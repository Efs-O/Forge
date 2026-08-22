/**
 * Stale-lease reclaim against REAL operating-system processes.
 *
 * `SharedRuntimeRegistry` takes an injectable `isAlive` so the unit tests can
 * drive it deterministically, which means those tests never exercise
 * `isProcessAlive` itself. This file spawns actual processes and kills them, so
 * the pid-liveness probe — the thing that decides whether an owner may unload —
 * is checked against the OS on whichever platform CI runs.
 *
 * Manual equivalent: test 3 in TWO_WINDOW_SMOKE_TEST.md (kill the borrowing
 * window from Task Manager, then unload in the owner). This covers the
 * bookkeeping half of it; the VRAM half still needs a real llama-server.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedRuntimeRegistry } from '../../src/backend/SharedRuntimeRegistry';
import { isProcessAlive } from '../../src/util/processLiveness';

const dirs: string[] = [];
const kids: ChildProcess[] = [];

/** A process that stays up until killed, on any platform vitest runs on. */
function spawnIdle(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
    stdio: 'ignore',
  });
  kids.push(child);
  return child;
}

/** Kill and wait for the OS to actually reap it — exit is not synchronous. */
async function killAndReap(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}

function mkRegistryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lease-'));
  dirs.push(dir);
  return dir;
}

/** Write a lease naming an arbitrary pid — acquireLease always uses our own. */
function writeLeaseFor(root: string, key: string, id: string, pid: number): string {
  const dir = path.join(root, `${key}.leases`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ pid, createdAt: new Date().toISOString() })}\n`);
  return file;
}

describe('stale lease reclaim (real processes)', () => {
  afterEach(async () => {
    for (const child of kids.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) await killAndReap(child);
    }
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a live borrower and reclaims one that was force-killed', async () => {
    const root = mkRegistryDir();
    const registry = new SharedRuntimeRegistry(root);
    const borrower = spawnIdle();
    expect(borrower.pid).toBeGreaterThan(0);

    const file = writeLeaseFor(root, 'k', 'borrower', borrower.pid!);
    // Live: the owner must NOT unload while this borrower is running.
    expect(registry.hasBorrowers('k')).toBe(true);
    expect(fs.existsSync(file)).toBe(true);

    await killAndReap(borrower);

    // Dead: this is the immortal-lease bug. Before the fix the file survived
    // forever and the owner could never unload again.
    expect(registry.hasBorrowers('k')).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps a live lease while reclaiming a dead one beside it', async () => {
    const root = mkRegistryDir();
    const registry = new SharedRuntimeRegistry(root);
    const alive = spawnIdle();
    const doomed = spawnIdle();

    const aliveFile = writeLeaseFor(root, 'k', 'alive', alive.pid!);
    const deadFile = writeLeaseFor(root, 'k', 'doomed', doomed.pid!);
    await killAndReap(doomed);

    expect(registry.hasBorrowers('k')).toBe(true);
    expect(fs.existsSync(deadFile)).toBe(false);
    expect(fs.existsSync(aliveFile)).toBe(true);
  });

  it('reclaims a corrupt lease rather than blocking the owner forever', () => {
    const root = mkRegistryDir();
    const registry = new SharedRuntimeRegistry(root);
    const dir = path.join(root, 'k.leases');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'truncated.json');
    fs.writeFileSync(file, '{"pid":');

    expect(registry.hasBorrowers('k')).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('probes this process and a never-valid pid correctly', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
