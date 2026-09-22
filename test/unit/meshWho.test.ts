import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAliases } from '../../src/agentMesh/aliasRegistry';
import { ownershipPath, writeOwnership, type OwnershipRecord } from '../../src/agentMesh/ownership';
import { projectWho, type WhoDeps } from '../../src/agentMesh/meshWho';

/**
 * The `forge.sh who` projection (AGENT_MESH_PLAN §11): two axes (attachment ×
 * activity), the honesty rule (non-observing ⇒ unknown, never idle), and the
 * dead-vs-unknown split. Pure — a temp busRoot with real alias/ownership files
 * plus injected in-memory signals.
 */

let root: string;
let deps: WhoDeps;

function own(rec: Partial<OwnershipRecord> & { alias: string }): void {
  writeOwnership(root, {
    agent: rec.agent ?? 'codex',
    session_id: rec.session_id ?? 'sess',
    owner_host: rec.owner_host ?? null,
    workspace: rec.workspace ?? '/ws',
    created_at: rec.created_at ?? 1,
    parked: rec.parked ?? false,
    ...(rec.thread_id ? { thread_id: rec.thread_id } : {}),
    ...rec,
  } as OwnershipRecord);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mesh-who-'));
  // isHostAlive(recorded, deps) reads deps.isAlive (the raw pid check) and
  // deps.processStartMs — NOT a top-level isHostAlive override. The fake owner
  // pids are not real processes, so the production default (real OS check) would
  // report them dead; inject isAlive=true + unknown start time (unprovable death
  // is treated as alive) to model "a live owner host".
  deps = {
    busRoot: root,
    knownAliases: () => ['forge', 'claude', 'codex'],
    isOwner: () => true,
    isBusy: () => false,
    forgeBusy: () => false,
    forgeInboxDepth: () => 0,
    hostLiveness: { isAlive: () => true, processStartMs: () => undefined },
  };
});

/** Model which owner pids are alive (the rest are proven dead). */
function setLiveness(fn: (pid: number) => boolean): void {
  deps.hostLiveness = { isAlive: fn, processStartMs: () => undefined };
}

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function byAlias(alias: string) {
  return projectWho(deps).find((p) => p.alias === alias);
}

describe('forge.sh who projection (§11)', () => {
  it('A1: always lists forge, plus every registered / owned / known alias', () => {
    writeAliases(root, {
      claude: { agent: 'claude', session_id: 'c1', registered_at: 1, by: 'user', peer_pid: 4242 },
      codex: { agent: 'codex', session_id: 't1', registered_at: 1, by: 'forge' },
    });
    own({ alias: 'codex', owner_host: { pid: 1, startedAt: 1 } });
    const rows = projectWho(deps);
    const aliases = rows.map((r) => r.alias);
    expect(aliases).toContain('forge');
    expect(aliases).toContain('claude');
    expect(aliases).toContain('codex');
    // forge is first (it is the hub).
    expect(rows[0].alias).toBe('forge');
    expect(rows[0].attachment).toBe('hub');
  });

  it('A2: two axes — a parked owned session is owned+parked, a busy one owned+busy', () => {
    own({ alias: 'codex', owner_host: { pid: 1, startedAt: 1 }, parked: true });
    expect(byAlias('codex')).toMatchObject({ attachment: 'owned', activity: 'parked' });

    own({ alias: 'codex', owner_host: { pid: 1, startedAt: 1 }, parked: false });
    deps.isBusy = () => true;
    expect(byAlias('codex')).toMatchObject({ attachment: 'owned', activity: 'busy' });
  });

  it('A3: a joined session is attached "joined" and its activity is unknown, never idle', () => {
    writeAliases(root, {
      claude: { agent: 'claude', session_id: 'c1', registered_at: 1, by: 'user', peer_pid: 33396 },
    });
    const row = byAlias('claude');
    expect(row).toMatchObject({ attachment: 'joined', activity: 'unknown' });
    expect(row?.detail).toContain('33396');
    // Even if the (injected) FIFO said busy, a joined session is not observable.
    deps.isBusy = () => true;
    expect(byAlias('claude')?.activity).toBe('unknown');
  });

  it('A3b: a joined session resumed under a new pid shows the live pid (matched by sessionId)', () => {
    writeAliases(root, {
      claude: {
        agent: 'claude', session_id: 'c1', registered_at: 1, by: 'user',
        peer_pid: 40252, claude_session_id: 'sess-1',
      },
    });
    const live = { pid: 28664, sessionId: 'sess-1', name: 'forge-0a', cwd: '', status: 'idle', sdk: false };
    deps.claudeSessions = () => [live];
    expect(byAlias('claude')).toMatchObject({ attachment: 'joined', activity: 'unknown', detail: 'pid 28664' });
  });

  it('A3c: a joined session that is not running is reported dead, not unknown', () => {
    writeAliases(root, {
      claude: {
        agent: 'claude', session_id: 'c1', registered_at: 1, by: 'user',
        peer_pid: 40252, claude_session_id: 'sess-1',
      },
    });
    deps.claudeSessions = () => [];
    expect(byAlias('claude')).toMatchObject({ attachment: 'joined', activity: 'dead' });
    expect(byAlias('claude')?.detail).toContain('open its panel');
  });

  it('A4: forge reports hub, and busy exactly when the active conversation streams', () => {
    deps.forgeBusy = () => false;
    deps.forgeInboxDepth = () => 2;
    expect(byAlias('forge')).toMatchObject({ attachment: 'hub', activity: 'idle' });
    expect(byAlias('forge')?.detail).toContain('inbox 2');

    deps.forgeBusy = () => true;
    expect(byAlias('forge')).toMatchObject({ attachment: 'hub', activity: 'busy' });
  });

  it('A5: dead only after proven death; a foreign LIVE owner is unknown, not dead', () => {
    // owner_host null → dead (a clean close).
    own({ alias: 'codex', owner_host: null, thread_id: 't1' });
    expect(byAlias('codex')).toMatchObject({ attachment: 'owned', activity: 'dead' });
    expect(byAlias('codex')?.detail).toContain('resume');

    // owner_host present but the host is proven dead (pid 888) → dead.
    setLiveness((pid) => pid !== 888);
    own({ alias: 'codex', owner_host: { pid: 888, startedAt: 1 } });
    expect(byAlias('codex')?.activity).toBe('dead');

    // owner_host present, host alive, but NOT this window → peer (we can write,
    // not watch), unknown, not idle. `owned` is reserved for the pipe holder.
    setLiveness(() => true);
    deps.isOwner = () => false; // a foreign live owner
    own({ alias: 'codex', owner_host: { pid: 999, startedAt: 1 } });
    expect(byAlias('codex')).toMatchObject({ attachment: 'peer', activity: 'unknown' });
  });

  it('a malformed owner_host is owned+unknown, not dead (unprovable death is not proven death)', () => {
    // owner_host present but not a valid {pid, startedAt}: readOwnership
    // normalizes it to null. Only a GENUINE null is dead; a corrupted one is
    // unknown — we cannot prove the owner dead, so we do not call it dead.
    fs.mkdirSync(path.dirname(ownershipPath(root, 'codex')), { recursive: true });
    fs.writeFileSync(
      ownershipPath(root, 'codex'),
      JSON.stringify({
        alias: 'codex',
        agent: 'codex',
        session_id: 's',
        owner_host: { pid: 'not-a-pid', startedAt: 1 },
        workspace: '/ws',
        created_at: 1,
        parked: false,
      }),
    );
    expect(byAlias('codex')).toMatchObject({ attachment: 'owned', activity: 'unknown' });
    expect(byAlias('codex')?.detail).toContain('malformed');
  });

  it('an owned session this host drives and is idle reports idle (the honest case)', () => {
    deps.isOwner = () => true;
    deps.isBusy = () => false;
    own({ alias: 'codex', owner_host: { pid: 1, startedAt: 1 } });
    expect(byAlias('codex')).toMatchObject({ attachment: 'owned', activity: 'idle' });
  });

  it('a config pin with no alias record and no ownership record is a peer (unknown), not idle', () => {
    // `gemini` is a known alias (a config pin) but has no alias record and no
    // ownership record: it is reached as a peer and is not observable.
    deps.knownAliases = () => ['forge', 'gemini'];
    expect(byAlias('gemini')).toMatchObject({ attachment: 'peer', activity: 'unknown' });
  });
});
