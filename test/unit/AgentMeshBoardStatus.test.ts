import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeAgentBoard } from '../../src/remote/RemoteSessionCommands';
import { setBoardContext } from '../../src/agentMesh/meshContext';
import { appendEvent } from '../../src/agentMesh/exchangeLog';
import { writeOwnership } from '../../src/agentMesh/ownership';

let root: string;
let logPath: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-boardstatus-'));
  logPath = path.join(root, 'exchanges.jsonl');
  setBoardContext({ root, workspace: '/ws', log: logPath });
});

afterEach(async () => {
  setBoardContext(undefined);
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('describeAgentBoard (P2, §3/M9, criterion 12)', () => {
  it('shows the last few exchanges for this conversation + a live-sessions line', async () => {
    const lock = path.join(root, 'exchanges.lock');
    await appendEvent({ log: logPath, lock }, {
      eventId: 'e1', ts: 1, exchangeId: 'a', workspace: '/ws', conversation: 'c1', from: 'codex', to: 'claude', type: 'relay', state: 'completed',
    });
    await appendEvent({ log: logPath, lock }, {
      eventId: 'e2', ts: 2, exchangeId: 'b', workspace: '/ws', conversation: 'c1', from: 'forge', to: 'codex', type: 'message', state: 'accepted',
    });
    writeOwnership(root, { alias: 'codex', agent: 'codex', session_id: 't', owner_host: { pid: 1, startedAt: 1 }, workspace: '/ws', created_at: 1, parked: false });

    const out = describeAgentBoard('c1');
    expect(out).toBeDefined();
    expect(out).toContain('Board:');
    // Newest first: b (accepted → queued) before a (completed).
    const boardLine = out!.split('\n')[0];
    expect(boardLine.indexOf('b') < boardLine.indexOf('a')).toBe(true);
    expect(boardLine).toContain('queued');
    expect(boardLine).toContain('completed');
    expect(out).toContain('Sessions:');
    expect(out).toContain('codex live');
  });

  it('is scoped to the conversation: another conversation is not shown (M9)', async () => {
    const lock = path.join(root, 'exchanges.lock');
    await appendEvent({ log: logPath, lock }, {
      eventId: 'e1', ts: 1, exchangeId: 'a', workspace: '/ws', conversation: 'c1', from: 'codex', to: 'claude', type: 'relay', state: 'completed',
    });
    await appendEvent({ log: logPath, lock }, {
      eventId: 'e2', ts: 2, exchangeId: 'b', workspace: '/ws', conversation: 'c2', from: 'forge', to: 'codex', type: 'message', state: 'accepted',
    });
    const out = describeAgentBoard('c1');
    const boardLine = out!.split('\n')[0];
    // Only c1's exchange (codex→claude) is in the board; c2's (forge→codex) is
    // excluded.
    expect(boardLine).toContain('codex→claude');
    expect(boardLine).not.toContain('forge→codex');
  });

  it('an unbound chat shows no board line, only the live-sessions line (M9)', () => {
    writeOwnership(root, { alias: 'codex', agent: 'codex', session_id: 't', owner_host: { pid: 1, startedAt: 1 }, workspace: '/ws', created_at: 1, parked: false });
    const out = describeAgentBoard(undefined);
    expect(out).toBeDefined();
    expect(out).not.toContain('Board:');
    expect(out).toContain('Sessions:');
    expect(out).toContain('codex live');
  });

  it('returns undefined when the agent bus is not up (no board invented)', () => {
    setBoardContext(undefined);
    expect(describeAgentBoard('c1')).toBeUndefined();
    expect(describeAgentBoard(undefined)).toBeUndefined();
  });

  it('shows "Board: none" when there are no exchanges for the conversation', () => {
    const out = describeAgentBoard('c1');
    expect(out).toContain('Board: none');
    expect(out).toContain('Sessions: none');
  });
});
