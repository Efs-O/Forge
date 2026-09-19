import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { busPaths, ensureBus, type BusPaths } from '../../src/agentBus/agentBus';
import {
  appendEvent,
  EXCHANGES_LOCK_NAME,
  EXCHANGES_LOG_NAME,
  newEventId,
} from '../../src/agentMesh/exchangeLog';
import { registerAlias } from '../../src/agentMesh/aliasRegistry';
import { writeOwnership } from '../../src/agentMesh/ownership';

/**
 * The plan's CI row for the mesh (AGENT_MESH_PLAN "State × lifecycle ledger",
 * CI row): the durable artifacts the mesh adds to the bus folder are exactly
 * `exchanges.jsonl`, `aliases.json`, `ownership/`, `exchanges.lock`, and
 * `status/` (empty when idle). Anything else in the folder is a stray file and
 * must fail — a new artifact needs a ledger row and cleanup first.
 */

let home: string;
let paths: BusPaths;

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-bus-'));
  paths = busPaths(home);
  ensureBus(paths);
});

afterEach(async () => {
  await fs.promises.rm(home, { recursive: true, force: true });
});

describe('bus folder contents with the mesh (CI row)', () => {
  it('adds only the mesh artifacts to the shipped bus files', async () => {
    // The shipped files (AGENT_MESSAGING_PLAN).
    const shipped = ['README.md', 'forge.sh', 'inbox', 'outbox'];
    // The mesh's durable artifacts. exchanges.lock is NOT listed: it is held
    // only for one write and released, so it is never present at rest.
    const meshFiles = [
      EXCHANGES_LOG_NAME, // exchanges.jsonl
      'aliases.json',
      'ownership', // per-alias records + claims
      'status', // status/<turn>.json (empty when idle)
    ];

    // Exercise the mesh: append an event, register an alias, write ownership.
    await appendEvent(
      { log: path.join(paths.root, EXCHANGES_LOG_NAME), lock: path.join(paths.root, EXCHANGES_LOCK_NAME) },
      {
        eventId: newEventId(),
        ts: 1,
        exchangeId: 'x1',
        workspace: '/ws',
        from: 'codex',
        to: 'forge',
        type: 'state',
        state: 'accepted',
      },
      {},
    );
    registerAlias(paths.root, 'codex', {
      agent: 'codex',
      session_id: 'thread-1',
      registered_at: 1,
      by: 'forge',
    });
    writeOwnership(paths.root, {
      alias: 'codex',
      agent: 'codex',
      session_id: 'thread-1',
      thread_id: 'thread-1',
      owner_host: { pid: 1, startedAt: 1 },
      workspace: '/ws',
      created_at: 1,
      parked: false,
    });
    fs.mkdirSync(path.join(paths.root, 'status'));

    const root = fs.readdirSync(paths.root).sort();
    const allowed = [...shipped, ...meshFiles].sort();
    // endpoint.json is published by the routes (not here), so it is not present.
    expect(root).toEqual(allowed);

    // The lock is released after a write, so it must not linger.
    expect(fs.existsSync(path.join(paths.root, EXCHANGES_LOCK_NAME))).toBe(false);

    // status/ is empty when idle.
    expect(fs.readdirSync(path.join(paths.root, 'status'))).toEqual([]);
    // ownership/ holds exactly the per-alias record.
    expect(fs.readdirSync(path.join(paths.root, 'ownership'))).toEqual(['codex.json']);
  });
});
