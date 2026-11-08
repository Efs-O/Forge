/**
 * The peer half of `message_chat`: finding the other windows on this machine and
 * posting to one of their chats. These tests run against real endpoint files in
 * a temporary bus folder and a real loopback server, because the two things that
 * matter here are "which windows are actually alive" and "a window that does not
 * answer is reported, not hung on".
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSelfWindow } from '../../src/agentBus/selfWindow';
import { peerRequest } from '../../src/agentBus/peerHttp';
import { writeWindowEndpoint } from '../../src/agentBus/windowEndpoints';
import {
  chatLabel,
  discoverPeers,
  findPeerChat,
  folderName,
  matchPeerWindow,
  peerContextFor,
  peerWindowTarget,
  postPeerMessage,
  type PeerWindow,
} from '../../src/tools/messageChatPeers';

const TOKEN = 'a'.repeat(32);
const WINDOW_A = '11111111-1111-4111-8111-111111111111';
const WINDOW_B = '22222222-2222-4222-8222-222222222222';
const WINDOW_DEAD = '33333333-3333-4333-8333-333333333333';
const WINDOW_SILENT = '44444444-4444-4444-8444-444444444444';
const WINDOW_TRICKLE = '55555555-5555-4555-8555-555555555555';
const WINDOW_JUNK = '66666666-6666-4666-8666-666666666666';

let busRoot: string;
let servers: http.Server[] = [];
/** What the live fake window answers for `GET /agent/chats`, mutable per test. */
let report: { windowId: string; workspace: string; models: string[]; chats: unknown[] } = {
  windowId: WINDOW_A,
  workspace: 'N:/repo-a',
  models: ['alpha'],
  chats: [],
};
let seenAuth: string[] = [];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

beforeAll(async () => {
  busRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-peer-endpoints-'));
  const live = http.createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(report));
  });
  const livePort = await listen(live);
  servers.push(live);
  // A window whose endpoint file is there and whose pid is alive, but whose
  // socket is closed: the port nothing listens on.
  const deadPort = 1;
  void deadPort;
  writeWindowEndpoint(busRoot, {
    windowId: WINDOW_A,
    url: `http://127.0.0.1:${livePort}`,
    token: TOKEN,
    pid: process.pid,
  });
  writeWindowEndpoint(busRoot, {
    windowId: WINDOW_DEAD,
    url: 'http://127.0.0.1:1',
    token: TOKEN,
    pid: process.pid,
  });
});

afterAll(() => {
  for (const server of servers) server.close();
  fs.rmSync(busRoot, { recursive: true, force: true });
});

const ctx = { busRoot: '', windowId: WINDOW_B, workspaceRoot: 'N:/repo-b' };

describe('peer discovery', () => {
  it('lists a live window with the chats it reported, and posts with its own token', async () => {
    report = {
      windowId: WINDOW_A,
      workspace: 'N:/repo-a',
      models: ['alpha'],
      chats: [
        { id: 'chat-1', title: 'Worker', running: true, closed: false, awaitingApproval: false },
        { id: 'chat-2', title: 'Old run', running: false, closed: true, awaitingApproval: false },
      ],
    };
    seenAuth = [];
    const { peers, unreachable } = await discoverPeers({ ...ctx, busRoot });
    expect(peers.map((peer) => peer.windowId)).toEqual([WINDOW_A]);
    expect(peers[0]!.chats.map((chat) => [chat.id, chat.closed])).toEqual([
      ['chat-1', false],
      ['chat-2', true],
    ]);
    // The dead socket is reported, not guessed at, and it never blocks the call.
    expect(unreachable.map((entry) => entry.windowId)).toEqual([WINDOW_DEAD]);
    expect(unreachable[0]!.reason).not.toBe('');
    expect(seenAuth).toEqual([`Bearer ${TOKEN}`]);
  });

  it('does not treat a second window on this folder as a peer', async () => {
    report = { windowId: WINDOW_A, workspace: 'N:/repo-b', models: [], chats: [] };
    const { peers } = await discoverPeers({ ...ctx, busRoot });
    expect(peers).toEqual([]);
  });

  it('matches a peer chat only by its full id', async () => {
    report = {
      windowId: WINDOW_A,
      workspace: 'N:/repo-a',
      models: [],
      chats: [
        { id: 'chat-1', title: 'Worker', running: false, closed: false, awaitingApproval: false },
      ],
    };
    const { peers } = await discoverPeers({ ...ctx, busRoot });
    const found = findPeerChat(peers, 'chat-1');
    expect(found?.chat.title).toBe('Worker');
    expect(findPeerChat(peers, 'worker')).toBeUndefined();
    expect(findPeerChat(peers, '#1')).toBeUndefined();
  });
});

/** A window that never finishes answering is the case that would otherwise hang
 *  `list`: the socket timeout measures inactivity, so a body that keeps arriving
 *  never trips it, and only a deadline over the whole call ends the wait. These
 *  three answer badly on purpose, in a bus folder of their own, so the healthy
 *  tests above keep asserting against a window that behaves. */
describe('a peer that misbehaves', () => {
  let root: string;
  let junkAsked = 0;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-peer-misbehaved-'));
    const silent = http.createServer(() => {
      // Holds the socket open and never writes a byte.
    });
    const trickle = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"windowId":"');
      const keep = setInterval(() => res.write('x'), 100);
      res.on('close', () => clearInterval(keep));
    });
    const junk = http.createServer((_req, res) => {
      junkAsked++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const bad = [
      [WINDOW_SILENT, silent],
      [WINDOW_TRICKLE, trickle],
      [WINDOW_JUNK, junk],
    ] as const;
    for (const [windowId, server] of bad) {
      const port = await listen(server);
      servers.push(server);
      writeWindowEndpoint(root, {
        windowId,
        url: `http://127.0.0.1:${port}`,
        token: TOKEN,
        pid: process.pid,
      });
    }
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports a silent, a trickling and a malformed window instead of hanging', async () => {
    const started = Date.now();
    const { peers, unreachable } = await discoverPeers({
      busRoot: root,
      windowId: WINDOW_B,
      workspaceRoot: 'N:/repo-b',
    });
    const took = Date.now() - started;
    expect(peers).toEqual([]);
    const reasons = new Map(unreachable.map((entry) => [entry.windowId, entry.reason]));
    expect([...reasons.keys()].sort()).toEqual([WINDOW_JUNK, WINDOW_SILENT, WINDOW_TRICKLE].sort());
    expect(reasons.get(WINDOW_SILENT)).toContain('5s');
    expect(reasons.get(WINDOW_TRICKLE)).toContain('5s');
    expect(reasons.get(WINDOW_JUNK)).toContain('could not read');
    // A trickling body keeps the socket active, so this can only be the
    // whole-call deadline: without it the call would still be open right here.
    expect(took).toBeLessThan(9_000);
  }, 30_000);

  it('ends a call the moment the turn is cancelled, instead of waiting out the deadline', async () => {
    const started = Date.now();
    const cancelled = new AbortController();
    const inFlight = discoverPeers(
      { busRoot: root, windowId: WINDOW_B, workspaceRoot: 'N:/repo-b' },
      cancelled.signal,
    );
    setTimeout(() => cancelled.abort(), 200);
    const { peers, unreachable } = await inFlight;
    expect(peers).toEqual([]);
    expect(unreachable.map((entry) => entry.reason)).toContain(
      'cancelled before the peer answered',
    );
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 30_000);

  it('sends nothing at all to a window when the turn was already cancelled', async () => {
    const before = junkAsked;
    const cancelled = new AbortController();
    cancelled.abort();
    const { peers, unreachable } = await discoverPeers(
      { busRoot: root, windowId: WINDOW_B, workspaceRoot: 'N:/repo-b' },
      cancelled.signal,
    );
    expect(peers).toEqual([]);
    expect(unreachable.map((entry) => entry.reason)).toContain(
      'cancelled before the peer was asked',
    );
    expect(junkAsked).toBe(before);
  });
});

describe('peer requests', () => {
  it('refuses to post a message that does not name its chat', async () => {
    const peer: PeerWindow = {
      windowId: WINDOW_A,
      url: 'http://127.0.0.1:1',
      token: TOKEN,
      workspace: 'N:/repo-a',
      models: [],
      chats: [],
    };
    const refused = await postPeerMessage(peer, { from: 'peer chat' }, 'text');
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.error).toContain('must name its chat');
  });

  it('calls an answer lost after the headers an outcome that may have landed', async () => {
    // The headers are out and the body never arrives: whether that window took
    // the message is exactly what this window cannot tell, so a caller may not
    // refund its counters on the strength of the socket closing.
    const headersOnly = http.createServer((_req, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
    });
    const port = await listen(headersOnly);
    servers.push(headersOnly);
    const cancelled = new AbortController();
    const inFlight = peerRequest(
      'POST',
      { url: `http://127.0.0.1:${port}`, token: TOKEN },
      '/agent/message?new_chat=true',
      'text',
      5_000,
      cancelled.signal,
    );
    setTimeout(() => cancelled.abort(), 200);
    const answer = await inFlight;
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.error).toContain('cancelled');
    expect(answer.uncertain).toBe(true);
  }, 10_000);
});

describe('the window a `new` is aimed at', () => {
  const peerA: PeerWindow = {
    windowId: WINDOW_A,
    url: 'http://127.0.0.1:1',
    token: TOKEN,
    workspace: 'N:/repo-b',
    models: [],
    chats: [],
  };
  const peerB: PeerWindow = { ...peerA, windowId: WINDOW_B, workspace: 'N:/other/repo-b' };

  it('matches a folder basename, a full folder or a full window id, and nothing shorter', () => {
    expect(matchPeerWindow([peerA], 'repo-b')).toEqual({ peer: peerA });
    expect(matchPeerWindow([peerA], 'N:/repo-b')).toEqual({ peer: peerA });
    expect(matchPeerWindow([peerA], WINDOW_A)).toEqual({ peer: peerA });
    expect(matchPeerWindow([peerA], '  repo-b  ')).toEqual({ peer: peerA });
    // `list` prints only the first eight characters of a window id, and only for
    // a window that would not answer at all — so a prefix here is a guess.
    expect(matchPeerWindow([peerA], WINDOW_A.slice(0, 8))).toMatchObject({
      refusal: expect.stringContaining('no other Forge window matches'),
    });
  });

  it('refuses a name that fits two windows, and one that fits none', () => {
    expect(matchPeerWindow([peerA, peerB], 'repo-b')).toMatchObject({
      refusal: expect.stringContaining('matches more than one window'),
    });
    const none = matchPeerWindow([peerA, peerB], 'nowhere');
    expect(none).toMatchObject({ refusal: expect.stringContaining('no other Forge window') });
    // The refusal names what IS there, so the caller can pick from it.
    if ('refusal' in none) expect(none.refusal).toContain('repo-b');
  });

  it('names a Windows-shaped folder by its basename on any platform', () => {
    // On Ubuntu a `\` is a legal filename character, so splitting by hand would
    // have answered with the whole path instead of the folder.
    expect(folderName('N:\\repo\\b')).toBe('b');
    expect(folderName('N:/repo-b')).toBe('repo-b');
    expect(folderName('N:/repo-b/')).toBe('repo-b');
    expect(folderName('/home/efso/repo-a')).toBe('repo-a');
  });

  it('says which switch would let this window name a window at all', async () => {
    const refused = await peerWindowTarget('repo-b', undefined, async () => ({
      peers: [],
      unreachable: [],
    }));
    expect(refused).toMatchObject({ refusal: expect.stringContaining('agent_bus.enabled') });
  });
});

describe('the sender label a peer sees', () => {
  it('never collides with a name a window routes by session, and never outgrows the rule', () => {
    for (const title of ['claude', 'codex', 'copilot', 'forge', 'Codex: task', '🧪 x'.repeat(20)]) {
      const label = chatLabel(title);
      expect(label).not.toMatch(/^(claude|codex|copilot|forge)$/iu);
      expect(label.length).toBeLessThanOrEqual(40);
      expect(label).toMatch(/^[0-9A-Za-z ._-]+$/u);
    }
    expect(chatLabel('')).toBe('peer chat');
  });
});

describe("this window's own bus address", () => {
  it('is absent until the bus is up here, and while the config has it off', () => {
    expect(peerContextFor(() => ({ agent_bus: { enabled: true } }) as never)).toBeUndefined();
    setSelfWindow({ busRoot, windowId: WINDOW_B, workspaceRoot: 'N:/repo-b' });
    expect(peerContextFor(() => ({ agent_bus: { enabled: false } }) as never)).toBeUndefined();
    expect(peerContextFor(() => undefined)).toBeUndefined();
    expect(peerContextFor(() => ({ agent_bus: { enabled: true } }) as never)).toEqual({
      busRoot,
      windowId: WINDOW_B,
      workspaceRoot: 'N:/repo-b',
    });
    setSelfWindow({ busRoot, windowId: WINDOW_A, workspaceRoot: 'N:/repo-a' });
  });
});
