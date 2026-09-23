import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMeshCommand, parseMeshCommand } from '../../src/agentMesh/meshCommands';
import { MeshSessionProvider } from '../../src/agentMesh/sessionProvider';
import { readOwnership, writeOwnership, type OwnershipRecord } from '../../src/agentMesh/ownership';
import { getHostIdentity } from '../../src/agentMesh/hostIdentity';
import type { ForgeConfig } from '../../src/config/types';

// ── Pure command grammar (§8) ────────────────────────────────────────────────

describe('parseMeshCommand (§8, P3)', () => {
  it('parses peer verbs with an alias', () => {
    expect(parseMeshCommand('say codex hello there')).toEqual({
      verb: 'say',
      alias: 'codex',
      message: 'hello there',
    });
    expect(parseMeshCommand('steer codex stop and report')).toEqual({
      verb: 'steer',
      alias: 'codex',
      message: 'stop and report',
    });
    expect(parseMeshCommand('standby claude')).toEqual({ verb: 'standby', alias: 'claude' });
    expect(parseMeshCommand('wake codex')).toEqual({ verb: 'wake', alias: 'codex' });
    expect(parseMeshCommand('handoff codex my part is done')).toEqual({
      verb: 'handoff',
      alias: 'codex',
      context: 'my part is done',
    });
    expect(parseMeshCommand('close codex')).toEqual({ verb: 'close', alias: 'codex' });
  });

  it('parses observational verbs with no arguments', () => {
    expect(parseMeshCommand('status')).toEqual({ verb: 'status' });
    expect(parseMeshCommand('board')).toEqual({ verb: 'board' });
    expect(parseMeshCommand('peers')).toEqual({ verb: 'peers' });
    expect(parseMeshCommand('queue')).toEqual({ verb: 'queue' });
    expect(parseMeshCommand('context')).toEqual({ verb: 'context' });
  });

  it('is case-insensitive on the verb and alias', () => {
    expect(parseMeshCommand('SAY Codex hi')).toEqual({ verb: 'say', alias: 'codex', message: 'hi' });
    expect(parseMeshCommand('Standby CLAUDE')).toEqual({ verb: 'standby', alias: 'claude' });
  });

  it('rejects a peer verb with no alias', () => {
    expect(parseMeshCommand('say')).toBeUndefined();
    expect(parseMeshCommand('standby')).toBeUndefined();
  });

  it('rejects `say` with no message', () => {
    expect(parseMeshCommand('say codex')).toBeUndefined();
  });

  it('rejects an observational verb with arguments', () => {
    expect(parseMeshCommand('status now')).toBeUndefined();
  });

  it('returns undefined for ordinary text', () => {
    expect(parseMeshCommand('please review the plan')).toBeUndefined();
    expect(parseMeshCommand('')).toBeUndefined();
    expect(parseMeshCommand('fly codex away')).toBeUndefined();
  });

  it('isMeshCommand reflects parseMeshCommand', () => {
    expect(isMeshCommand('standby codex')).toBe(true);
    expect(isMeshCommand('hello world')).toBe(false);
  });
});

// ── Standby state machine (§2b, P3) ──────────────────────────────────────────

let root: string;
/**
 * This window's start time, injected. The real reader spawns PowerShell on
 * Windows (~0.7 s locally, several on a loaded CI runner), which is what
 * pushed these tests past vitest's 5 s timeout.
 */
const selfStart = { processStartMs: () => 1_700_000_000_000 };
function makeProvider(): MeshSessionProvider {
  const config: ForgeConfig = { agent_bus: { claude_session: '', codex_thread: '' } } as ForgeConfig;
  return new MeshSessionProvider({
    busRoot: root,
    getConfig: () => config,
    workspaceRoots: () => ['/ws'],
    ...selfStart,
  });
}

function seedRecord(alias: string, patch: Partial<OwnershipRecord> = {}): void {
  // Default owner_host is THIS window (the owner case): park/wake/close are
  // owner-authorized (F-02). A test that models a foreign window passes a
  // foreign owner_host explicitly.
  const rec: OwnershipRecord = {
    alias,
    agent: 'codex',
    session_id: 'thread-1',
    thread_id: 'thread-1',
    owner_host: getHostIdentity(selfStart),
    workspace: '/ws',
    created_at: 1,
    parked: false,
    ...patch,
  };
  writeOwnership(root, rec);
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-standby-'));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('standby state machine (§2b, P3)', () => {
  it('park sets parked: true on the ownership record (durable)', () => {
    seedRecord('codex');
    const p = makeProvider();
    expect(p.park('codex')).toBe(true);
    expect(readOwnership(root, 'codex')?.parked).toBe(true);
    expect(p.isParked('codex')).toBe(true);
  });

  it('park is a no-op (false) when there is no ownership record', () => {
    const p = makeProvider();
    expect(p.park('codex')).toBe(false);
    expect(p.isParked('codex')).toBe(false);
  });

  it('wake clears parked and is a no-op when not parked', () => {
    seedRecord('codex', { parked: true });
    const p = makeProvider();
    expect(p.wake('codex')).toBe(true);
    expect(readOwnership(root, 'codex')?.parked).toBe(false);
    expect(p.isParked('codex')).toBe(false);
    // A second wake on an already-unparked record still returns true (idempotent).
    expect(p.wake('codex')).toBe(true);
    expect(readOwnership(root, 'codex')?.parked).toBe(false);
  });

  it('close clears owner_host but keeps thread_id (M3: resumable)', async () => {
    seedRecord('codex', { thread_id: 'thread-1' });
    const p = makeProvider();
    expect(await p.close('codex')).toBe(true);
    const rec = readOwnership(root, 'codex');
    expect(rec?.owner_host).toBeNull();
    expect(rec?.thread_id).toBe('thread-1');
    expect(rec?.parked).toBe(false);
  });

  it('close is a no-op (false) for a user-opened session (no record)', async () => {
    const p = makeProvider();
    expect(await p.close('ghost')).toBe(false);
  });

  it('F-02: a foreign window cannot park/wake/close a session it does not own', async () => {
    // A record owned by ANOTHER live window: this window is not the owner, so
    // the lifecycle mutations are refused and the record is left intact.
    const foreign = { pid: 1, startedAt: 1 }; // a live foreign host (pid 1 is alive)
    seedRecord('codex', { owner_host: foreign });
    const p = makeProvider();
    expect(p.park('codex')).toBe(false);
    expect(p.wake('codex')).toBe(false);
    expect(await p.close('codex')).toBe(false);
    // The record is untouched: the foreign owner_host is still set.
    expect(readOwnership(root, 'codex')?.owner_host).toEqual(foreign);
    expect(readOwnership(root, 'codex')?.parked).toBe(false);
  });

  it('F-02: a LIVE foreign owner (matching start time) is still not the owner', () => {
    // The hard case the previous test missed: a foreign host that isHostAlive
    // considers LIVE (pid alive, start time matches) but is NOT this window.
    // `isOwner` must still refuse — using `isHostAlive` alone would return true
    // for a live foreign host and let a peer window mutate a session it does
    // not own. The distinguishing check is the pid match.
    const foreignPid = 424242;
    const selfPid = 999999;
    const startedAt = 1_700_000_000_000;
    const foreign = { pid: foreignPid, startedAt };
    seedRecord('codex', { owner_host: foreign });
    const cfg: ForgeConfig = { agent_bus: { claude_session: '', codex_thread: '' } } as ForgeConfig;
    const p = new MeshSessionProvider({
      busRoot: root,
      getConfig: () => cfg,
      workspaceRoots: () => ['/ws'],
      selfPid,
      isAlive: (pid) => pid === foreignPid || pid === selfPid,
      processStartMs: () => startedAt, // both hosts report the same start time
    });
    expect(p.isOwner('codex')).toBe(false);
    expect(p.isOwned('codex')).toBe(false);
    expect(p.park('codex')).toBe(false);
    expect(p.wake('codex')).toBe(false);
    expect(readOwnership(root, 'codex')?.owner_host).toEqual(foreign);
    expect(readOwnership(root, 'codex')?.parked).toBe(false);
  });
});
