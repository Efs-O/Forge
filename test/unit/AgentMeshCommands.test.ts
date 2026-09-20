import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMeshCommand, parseMeshCommand } from '../../src/agentMesh/meshCommands';
import { MeshSessionProvider } from '../../src/agentMesh/sessionProvider';
import { readOwnership, writeOwnership, type OwnershipRecord } from '../../src/agentMesh/ownership';
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
function makeProvider(): MeshSessionProvider {
  const config: ForgeConfig = { agent_bus: { claude_session: '', codex_thread: '' } } as ForgeConfig;
  return new MeshSessionProvider({
    busRoot: root,
    getConfig: () => config,
    workspaceRoots: () => ['/ws'],
  });
}

function seedRecord(alias: string, patch: Partial<OwnershipRecord> = {}): void {
  const rec: OwnershipRecord = {
    alias,
    agent: 'codex',
    session_id: 'thread-1',
    thread_id: 'thread-1',
    owner_host: { pid: 1, startedAt: 1000 },
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
});
