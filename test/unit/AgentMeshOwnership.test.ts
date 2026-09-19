import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimCreation,
  currentHost,
  isClaimStale,
  listOwnedAliases,
  readOwnership,
  recoverOwnership,
  releaseClaim,
  writeOwnership,
  type OwnershipRecord,
} from '../../src/agentMesh/ownership';
import type { HostId, HostLivenessDeps } from '../../src/agentMesh/hostIdentity';

let root: string;

function host(pid: number, startedAt = 1000): HostId {
  return { pid, startedAt };
}

function deps(alivePids: Set<number>, selfPid = 999_999): HostLivenessDeps {
  return {
    selfPid,
    isAlive: (p) => alivePids.has(p),
    isHostAlive: (h) => alivePids.has(h.pid),
    processStartMs: (p) => (alivePids.has(p) ? 1000 : undefined),
  };
}

function record(alias: string, owner: HostId | null, thread_id?: string): OwnershipRecord {
  return {
    alias,
    agent: 'codex',
    session_id: 'sess',
    ...(thread_id ? { thread_id } : {}),
    owner_host: owner,
    workspace: '/ws',
    created_at: 1,
    parked: false,
  };
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-own-'));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('ownership + creation lease (M2/M3)', () => {
  it('writes and reads a per-alias record', () => {
    writeOwnership(root, record('codex', host(5), 'thread-1'));
    const rec = readOwnership(root, 'codex');
    expect(rec?.owner_host).toEqual(host(5));
    expect(rec?.thread_id).toBe('thread-1');
    expect(listOwnedAliases(root)).toEqual(['codex']);
  });

  it('claimCreation: the first host claims; a second live host loses', () => {
    const d = deps(new Set([1, 2]));
    expect(claimCreation(root, 'codex', host(1), d)).toEqual({ claimed: true });
    // Window 2 sees the live claim and must wait, not race a second spawn.
    expect(claimCreation(root, 'codex', host(2), d)).toEqual({ claimed: false, holder: host(1) });
  });

  it('a slow-but-live claimant is never raced into a second spawn (M2)', () => {
    const d = deps(new Set([1, 2]));
    claimCreation(root, 'codex', host(1), d);
    // The claimant is alive (just slow): the second caller reports "creation in
    // progress" rather than reclaiming and double-spawning.
    const res = claimCreation(root, 'codex', host(2), d);
    expect(res.claimed).toBe(false);
    expect(isClaimStale(root, 'codex', d)).toBe(false);
  });

  it('a dead claimant is reclaimed (M2)', () => {
    const d = deps(new Set([2])); // pid 1 is dead
    claimCreation(root, 'codex', host(1), d);
    expect(isClaimStale(root, 'codex', d)).toBe(true);
    // Window 2 reclaims the dead claim.
    expect(claimCreation(root, 'codex', host(2), d)).toEqual({ claimed: true });
  });

  it('a torn claim is never reclaimed — it proves nothing, so the waiter waits (M2)', () => {
    const d = deps(new Set([1, 2])); // both alive
    // Simulate a claimant mid-write: the file exists but its JSON is torn/empty,
    // so it names no host. Reclaiming it would race a possibly-live creator into
    // a double spawn; the waiter must wait (bounded) and report "in progress".
    const claimFile = path.join(root, 'ownership', 'codex.claim');
    fs.mkdirSync(path.dirname(claimFile), { recursive: true });
    fs.writeFileSync(claimFile, '{"host_pid":'); // torn: incomplete JSON
    const res = claimCreation(root, 'codex', host(2), { ...d, deadlineMs: 30 });
    expect(res.claimed).toBe(false);
    expect(res.holder).toBeUndefined(); // no host to attribute
    // The torn claim is NOT stale (no dead host to prove), and the file is
    // untouched — the waiter did not race the (possibly live) creator.
    expect(isClaimStale(root, 'codex', d)).toBe(false);
    expect(fs.readFileSync(claimFile, 'utf8')).toBe('{"host_pid":');
  });

  it('releaseClaim removes the claim', () => {
    const d = deps(new Set([1]));
    claimCreation(root, 'codex', host(1), d);
    releaseClaim(root, 'codex');
    expect(isClaimStale(root, 'codex', d)).toBe(false);
    expect(claimCreation(root, 'codex', host(1), d)).toEqual({ claimed: true });
  });

  it('recovery leaves a peer window live session untouched (M2)', () => {
    writeOwnership(root, record('codex', host(5), 'thread-1'));
    const d = deps(new Set([5])); // window 5 (another host) is alive
    const res = recoverOwnership(root, d);
    expect(res.actions).toEqual([{ alias: 'codex', action: 'untouched' }]);
    expect(readOwnership(root, 'codex')?.owner_host).toEqual(host(5));
  });

  it('recovery reaps a dead owner but keeps the thread_id (M3)', () => {
    writeOwnership(root, record('codex', host(5), 'thread-1'));
    const d = deps(new Set([999_999])); // pid 5 is dead
    const res = recoverOwnership(root, d);
    expect(res.actions).toEqual([{ alias: 'codex', action: 'reaped', thread_id: 'thread-1' }]);
    const rec = readOwnership(root, 'codex');
    expect(rec?.owner_host).toBeNull(); // reaped
    expect(rec?.thread_id).toBe('thread-1'); // kept for resume
  });

  it('recovery reports a stale orphan claim with no record (M2)', () => {
    const d = deps(new Set([999_999])); // pid 1 dead
    claimCreation(root, 'ghost', host(1), d);
    const res = recoverOwnership(root, d);
    expect(res.actions).toContainEqual({ alias: 'ghost', action: 'orphan-claim' });
  });

  it('currentHost reports the calling host', () => {
    const d = deps(new Set([7]), 7);
    expect(currentHost(d)).toEqual(host(7));
  });
});
