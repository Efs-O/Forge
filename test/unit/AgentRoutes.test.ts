import { execFile } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import {
  busPaths,
  clearExchange,
  replyFile,
  waitForReply,
  writeQuestion,
  type BusPaths,
} from '../../src/agentBus/agentBus';
import { AgentRoutes } from '../../src/backend/agentRoutes';
import { PendingAgentReplies } from '../../src/agentLinks/pendingAgentReplies';
import { windowEndpointPath } from '../../src/agentBus/windowEndpoints';
import { TEST_BASH } from '../support/bash';
import { listenLoopback } from '../support/listenLoopback';

const TOKEN = 'f'.repeat(64);

function gitBashPath(windowsPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(windowsPath);
  if (!match) return windowsPath.replace(/\\/gu, '/');
  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/gu, '/')}`;
}

/** Keep MSYS's /tmp mount alive until the whole Vitest run ends. */
function gitBashEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const runDir = inject('tempGuardRunDir');
  return {
    ...process.env,
    ...overrides,
    ...(process.platform === 'win32' ? { TEMP: runDir, TMP: runDir } : {}),
    TMPDIR: process.platform === 'win32' ? gitBashPath(runDir) : runDir,
  };
}

let home: string;
let paths: BusPaths;
let accepted: string[];
let acceptedOptions: unknown[];
/** Queued message id → sender, for the stub inbox's `cancel`. */
let queuedFrom: Map<string, string>;
let full: boolean;
let routes: AgentRoutes;
let server: http.Server;
let base: string;
let focused: boolean;

beforeAll(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-agent-routes-'));
  server = http.createServer((req, res) => void routes.handle(req, res));
  const port = await listenLoopback(server);
  base = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
  await fs.promises.rm(home, { recursive: true, force: true });
  await fs.promises.mkdir(home, { recursive: true });
  paths = busPaths(home);
  accepted = [];
  acceptedOptions = [];
  queuedFrom = new Map();
  full = false;
  focused = true;
  routes = new AgentRoutes({
    paths: () => paths,
    isFocused: () => focused,
    inbox: {
      accept: (prompt, from, _front, options) => {
        if (full) return undefined;
        accepted.push(prompt);
        acceptedOptions.push(options);
        const id = `m${accepted.length}`;
        queuedFrom.set(id, from ?? '');
        return { position: accepted.length, id };
      },
      cancel: (from, id) => {
        let n = 0;
        for (const [qid, qfrom] of queuedFrom) {
          if (qfrom === from && (id === 'all' || qid === id)) n += Number(queuedFrom.delete(qid));
        }
        return n;
      },
    },
    token: TOKEN,
    configuredModels: () => ['alpha', 'beta'],
  });
  routes.setEnabled(true);
  routes.onListening(base);
});

afterEach(() => {
  routes.dispose();
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.promises.rm(home, { recursive: true, force: true });
});

/** An inbox that records prompts and cancels nothing. */
function stubInbox() {
  return {
    accept: (p: string) => (
      accepted.push(p),
      { position: accepted.length, id: `m${accepted.length}` }
    ),
    cancel: () => 0,
  };
}

async function post(
  route: string,
  body: string,
  { token = TOKEN, type = 'text/plain' }: { token?: string | null; type?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': type };
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}${route}`, { method: 'POST', headers, body });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('endpoint.json', () => {
  it('is published with the url and token, and removed on dispose', () => {
    const ep = JSON.parse(fs.readFileSync(paths.endpoint, 'utf8'));
    expect(ep).toMatchObject({ url: base, token: TOKEN });
    expect(fs.existsSync(windowEndpointPath(paths.root, routes.windowId))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.endpoint).mode & 0o777).toBe(0o600);
    }
    routes.dispose();
    expect(fs.existsSync(paths.endpoint)).toBe(false);
    expect(fs.existsSync(windowEndpointPath(paths.root, routes.windowId))).toBe(false);
  });

  it('answers holds-link only for a valid kind-specific session id', async () => {
    const held = new AgentRoutes({
      paths: () => paths,
      token: TOKEN,
      inbox: stubInbox(),
      holdsLink: (sender) => sender.kind === 'codex',
    });
    held.setEnabled(true);
    held.onListening(base);
    routes = held;
    try {
      const good = await fetch(
        `${base}/agent/holds-link?kind=codex&sessionId=00000000-0000-4000-8000-000000000071`,
        { headers: { Authorization: `Bearer ${TOKEN}` } },
      );
      expect(await good.json()).toEqual({ holdsLink: true, cwdMatch: 0 });
      const bad = await fetch(`${base}/agent/holds-link?kind=codex&sessionId=bad`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(bad.status).toBe(400);
    } finally {
      held.dispose();
    }
  });

  it("answers cwdMatch with the workspace root's length only for a folder inside it", async () => {
    const root = path.join(home, 'repo');
    const held = new AgentRoutes({
      paths: () => paths,
      token: TOKEN,
      inbox: stubInbox(),
      workspaceRoot: root,
      holdsLink: () => false,
    });
    held.setEnabled(true);
    held.onListening(base);
    routes = held;
    const match = async (cwd: string) => {
      const query = new URLSearchParams({
        kind: 'claude',
        sessionId: '00000000-0000-4000-8000-000000000072',
        cwd,
      });
      const res = await fetch(`${base}/agent/holds-link?${query}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      return ((await res.json()) as { cwdMatch: number }).cwdMatch;
    };
    try {
      expect(await match(root)).toBe(path.resolve(root).length);
      expect(await match(path.join(root, 'src', 'deep'))).toBe(path.resolve(root).length);
      expect(await match(path.join(home, 'repo-other'))).toBe(0);
      expect(await match(home)).toBe(0);
      expect(await match('repo')).toBe(0);
    } finally {
      held.dispose();
    }
  });

  it('matches a folder reported through the symlinked workspace resolved (macOS /var)', async () => {
    const real = path.join(home, 'real-repo');
    const linked = path.join(home, 'linked-repo');
    fs.mkdirSync(path.join(real, 'src'), { recursive: true });
    fs.symlinkSync(real, linked, 'junction');
    const held = new AgentRoutes({
      paths: () => paths,
      token: TOKEN,
      inbox: stubInbox(),
      workspaceRoot: linked,
      holdsLink: () => false,
    });
    held.setEnabled(true);
    held.onListening(base);
    routes = held;
    try {
      const query = new URLSearchParams({
        kind: 'claude',
        sessionId: '00000000-0000-4000-8000-000000000073',
        cwd: fs.realpathSync.native(path.join(real, 'src')),
      });
      const res = await fetch(`${base}/agent/holds-link?${query}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(await res.json()).toEqual({ holdsLink: false, cwdMatch: path.resolve(linked).length });
    } finally {
      held.dispose();
    }
  });

  it("is never removed when another window's token is in it", () => {
    fs.writeFileSync(paths.endpoint, JSON.stringify({ url: 'x', token: 'other' }));
    routes.dispose();
    expect(fs.existsSync(paths.endpoint)).toBe(true);
  });

  it('follows agent_bus.enabled on refresh', () => {
    routes.setEnabled(false);
    expect(fs.existsSync(paths.endpoint)).toBe(false);
    routes.setEnabled(true);
    expect(fs.existsSync(paths.endpoint)).toBe(true);
  });

  it('lets an unfocused window take the endpoint only when no live window owns it', () => {
    routes.dispose();
    // Another live window (this test process) owns it: an unfocused window leaves it.
    const other = {
      windowId: '00000000-0000-4000-8000-000000000042',
      url: 'http://127.0.0.1:1',
      token: 'o'.repeat(64),
      pid: process.pid,
    };
    fs.writeFileSync(paths.endpoint, JSON.stringify(other));
    focused = false;
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      isFocused: () => focused,
    });
    routes.setEnabled(true);
    routes.onListening(base);
    expect(JSON.parse(fs.readFileSync(paths.endpoint, 'utf8'))).toMatchObject({
      token: other.token,
    });

    focused = true;
    routes.claim();
    expect(JSON.parse(fs.readFileSync(paths.endpoint, 'utf8'))).toMatchObject({
      url: base,
      token: TOKEN,
    });

    // Unfocused: keeps its own file rather than withdrawing it.
    focused = false;
    routes.claim();
    expect(JSON.parse(fs.readFileSync(paths.endpoint, 'utf8'))).toMatchObject({ token: TOKEN });

    // An unreadable file has no owner, so even an unfocused window replaces it.
    fs.writeFileSync(paths.endpoint, JSON.stringify({ url: 'other', token: 'other' }));
    routes.claim();
    expect(JSON.parse(fs.readFileSync(paths.endpoint, 'utf8'))).toMatchObject({ token: TOKEN });
  });
});

describe('auth and limits', () => {
  it('answers 401 without a token or with a wrong one, and queues nothing', async () => {
    expect((await post('/agent/message?from=x', 'hi', { token: null })).status).toBe(401);
    expect((await post('/agent/message?from=x', 'hi', { token: 'e'.repeat(64) })).status).toBe(401);
    expect((await post('/agent/message?from=x', 'hi', { token: 'short' })).status).toBe(401);
    expect(accepted).toEqual([]);
  });

  it('answers 404 while disabled, even with the token', async () => {
    routes.setEnabled(false);
    expect((await post('/agent/message?from=x', 'hi')).status).toBe(404);
  });

  it('rejects an oversized text, a bad sender and a bad id with 400', async () => {
    expect((await post('/agent/message?from=x', 'a'.repeat(8001))).status).toBe(400);
    expect((await post('/agent/message?from=x', 'a'.repeat(8000))).status).toBe(202);
    expect((await post('/agent/message?from=%3Cscript%3E', 'hi')).status).toBe(400);
    expect((await post('/agent/message', 'hi')).status).toBe(400);
    expect((await post('/agent/message?from=x', '   ')).status).toBe(400);
    expect((await post('/agent/reply?id=..%2Fx', 'hi')).status).toBe(400);
    expect((await post('/agent/message', '{', { type: 'application/json' })).status).toBe(400);
  });

  it('answers 429 when the inbox is full', async () => {
    full = true;
    expect((await post('/agent/message?from=x', 'hi')).status).toBe(429);
  });
});

describe('routes', () => {
  it('refuses a --new at an unrecoverable cap with 409 and the reasons, queueing nothing', async () => {
    // The lie this closes: the route used to answer 202 for a message `drain()`
    // could never deliver, because the 202 is the last thing the caller sees.
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      configuredModels: () => ['alpha', 'beta'],
      chatCapBlockers: (options) => {
        expect(options).toEqual({ activate: true });
        return ['7 running a turn', '5 bound to a remote chat'];
      },
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const response = await post('/agent/message?from=codex&new_chat=true', 'start a phase');
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('7 running a turn');
    expect(response.body.error).toContain('5 bound to a remote chat');
    expect(response.body.error).toContain('not queued');
    // No id, and nothing in the inbox: the sender is not left holding a message
    // it believes is pending.
    expect(response.body).not.toHaveProperty('id');
    expect(accepted).toEqual([]);
  });

  it('accepts a --new when a slot can be freed, and never pre-flights an ordinary message', async () => {
    let asked = 0;
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      configuredModels: () => ['alpha', 'beta'],
      chatCapBlockers: () => {
        asked++;
        return [];
      },
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const fresh = await post('/agent/message?from=codex&new_chat=true', 'start a phase');
    expect(fresh.status).toBe(202);
    expect(fresh.body).toMatchObject({ id: expect.any(String) });
    expect(asked).toBe(1);

    // Only `--new` needs a tab, so only `--new` pays for the question.
    const ordinary = await post('/agent/message?from=codex', 'follow-up');
    expect(ordinary.status).toBe(202);
    expect(asked).toBe(1);
  });

  it('opens a --new chat at once, names it in the 202, and queues into it', async () => {
    const asked: unknown[] = [];
    const options: unknown[] = [];
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: {
        accept: (prompt, _from, _front, messageOptions) => (
          accepted.push(prompt),
          options.push(messageOptions),
          { position: accepted.length, id: `m${accepted.length}` }
        ),
        cancel: () => 0,
      },
      token: TOKEN,
      configuredModels: () => ['alpha', 'beta'],
      chatCapBlockers: () => [],
      openBusChat: async (open) => {
        asked.push(open);
        return { ok: true, id: 'worker-1', title: 'Codex: start a phase' };
      },
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const response = await post(
      '/agent/message?from=forge-x&new_chat=true&model=alpha&title=Worker%20one',
      'start a phase',
    );
    expect(response.status).toBe(202);
    // The sender learns which chat its worker is in from the same call that
    // opened it; the answer before this one could only say "queued".
    expect(response.body).toMatchObject({
      conversationId: 'worker-1',
      title: 'Codex: start a phase',
      id: expect.any(String),
    });
    expect(asked).toEqual([{ model: 'alpha', title: 'Worker one' }]);
    // The drain must deliver into that chat, not open another, so the chat is
    // named and the pin it already applied is dropped — the same model is not
    // asked for twice before the turn even starts. `newChat` stays set on
    // purpose: it is the marker that says this message still needs a turn of its
    // own, so a turn started in that chat while this one was being admitted
    // cannot swallow the owner's first message as a mid-turn tell.
    expect(options).toEqual([
      { newChat: true, targetConversationId: 'worker-1', title: 'Worker one' },
    ]);
  });

  it('answers 409 with the chat a failed pin left behind, and queues nothing', async () => {
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      configuredModels: () => ['alpha', 'beta'],
      chatCapBlockers: () => [],
      openBusChat: async () => ({ ok: false, id: 'worker-9', error: 'model load refused' }),
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const response = await post('/agent/message?from=forge-x&new_chat=true&model=alpha', 'go');
    expect(response.status).toBe(409);
    // The id is in the sentence because the chat exists either way, and the
    // owner has to be able to find the empty one to close it.
    expect(response.body.error).toContain('worker-9');
    expect(response.body.error).toContain('model load refused');
    expect(response.body).not.toHaveProperty('id');
    expect(accepted).toEqual([]);
  });

  it('asks the cap before opening anything, so a full window opens no chat', async () => {
    let opened = 0;
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      configuredModels: () => ['alpha', 'beta'],
      chatCapBlockers: () => ['7 running a turn'],
      openBusChat: async () => {
        opened++;
        return { ok: true, id: 'x', title: 'x' };
      },
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const response = await post('/agent/message?from=forge-x&new_chat=true', 'go');
    expect(response.status).toBe(409);
    expect(opened).toBe(0);
    expect(accepted).toEqual([]);
  });

  it('refuses an unknown model or an overlong title before opening a chat', async () => {
    let opened = 0;
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      configuredModels: () => ['alpha', 'beta'],
      chatCapBlockers: () => [],
      openBusChat: async () => {
        opened++;
        return { ok: true, id: 'x', title: 'x' };
      },
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const badModel = await post('/agent/message?from=forge-x&new_chat=true&model=nope', 'go');
    expect(badModel.status).toBe(400);
    expect(badModel.body.error).toContain('alpha, beta');
    // A name longer than a chat can be is refused here rather than truncated by
    // whichever window happens to receive the message.
    const badTitle = await post(
      `/agent/message?from=forge-x&new_chat=true&title=${'t'.repeat(81)}`,
      'go',
    );
    expect(badTitle.status).toBe(400);
    expect(badTitle.body.error).toContain('title');
    expect(opened).toBe(0);
    expect(accepted).toEqual([]);
  });


  it('turns a message into a labelled prompt (text or JSON)', async () => {
    const plain = await post('/agent/message?from=forge-dd', 'hello');
    expect(plain).toEqual({ status: 202, body: { queued: 1, id: 'm1' } });
    const json = await post('/agent/message', JSON.stringify({ from: 'codex', text: 'yo' }), {
      type: 'application/json',
    });
    expect(json.status).toBe(202);
    expect(accepted[0]).toContain('**forge-dd says:**\n\nhello');
    expect(accepted[1]).toContain('**codex says:**\n\nyo');
  });

  it('accepts a configured model and a fresh-chat target', async () => {
    const response = await post(
      '/agent/message',
      JSON.stringify({ from: 'codex', text: 'new phase', model: 'alpha', new_chat: true }),
      { type: 'application/json' },
    );
    expect(response.status).toBe(202);
    expect(acceptedOptions[0]).toEqual({ model: 'alpha', newChat: true });
  });

  it('names the resolved Forge chat in the accepted-message response', async () => {
    const options: unknown[] = [];
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: {
        accept: (_prompt, _from, _front, messageOptions) => (
          options.push(messageOptions),
          { position: 1, id: 'm1' }
        ),
        cancel: () => 0,
      },
      token: TOKEN,
      resolveChatTarget: (_from, selection) => ({
        ok: true,
        conversationId: selection.conversationId ?? 'running-chat',
        title: 'Q6 investigation',
      }),
    });
    routes.setEnabled(true);
    routes.onListening(base);

    const response = await post(
      '/agent/message?from=codex&to_running=true',
      'continue the investigation',
    );

    expect(response).toEqual({
      status: 202,
      body: {
        queued: 1,
        id: 'm1',
        conversationId: 'running-chat',
        title: 'Q6 investigation',
      },
    });
    expect(options[0]).toMatchObject({ targetConversationId: 'running-chat' });
  });

  it('reports a steer that found no running Forge turn', async () => {
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      resolveChatTarget: () => ({
        ok: true,
        conversationId: 'sender-chat',
        title: 'Codex: task',
      }),
      interruptForge: async () => ({
        steered: false,
        reason: 'Forge chat "Codex: task" (sender-chat) is not streaming',
      }),
    });
    routes.setEnabled(true);
    routes.onListening(base);

    expect(await post('/agent/message?from=codex&to=forge&priority=steer', 'stop')).toEqual({
      status: 202,
      body: {
        queued: expect.any(Number),
        id: expect.any(String),
        steered: false,
        reason: 'Forge chat "Codex: task" (sender-chat) is not streaming',
      },
    });
  });

  it('refuses a steer this window cannot interrupt, and queues nothing', async () => {
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      resolveChatTarget: () => ({ ok: true, conversationId: 'sender-chat', title: 'Codex: task' }),
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const response = await post('/agent/message?from=codex&to=forge&priority=steer', 'stop');
    // Without an interrupt handler this window answers a steer the way it
    // answers a plain send — "queued" — and the sender would report an
    // interruption that nothing here was ever going to make.
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('cannot steer');
    expect(accepted).toEqual([]);
  });

  it('takes the message back when the chat is waiting for the owner, and refuses', async () => {
    const cancelled: string[] = [];
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: {
        accept: (prompt) => (
          accepted.push(prompt),
          { position: accepted.length, id: `m${accepted.length}` }
        ),
        cancel: (_from, id) => (cancelled.push(id), 1),
      },
      token: TOKEN,
      resolveChatTarget: () => ({ ok: true, conversationId: 'sender-chat', title: 'Codex: task' }),
      // The sender checked the chat list a tool round ago; this window answers
      // from the card that is actually out, and says so with `blocked`.
      interruptForge: async () => ({
        steered: false,
        blocked: true,
        reason: 'Forge chat "Codex: task" is waiting for the owner\'s approval',
      }),
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const response = await post('/agent/message?from=codex&to=forge&priority=steer', 'stop');
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("waiting for the owner's approval");
    expect(response.body.error).toContain('Nothing was queued');
    // It was accepted before the interrupt was attempted, so the route has to
    // take it back: left in the inbox it would run in front of a question the
    // owner has not answered.
    expect(cancelled).toEqual(['m1']);
    expect(accepted).toEqual(['**codex says:**\n\nstop']);
  });

  it('refuses a steer whose chain has moved on, before its message is queued', async () => {
    const epochs: (number | undefined)[] = [];
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      resolveChatTarget: () => ({ ok: true, conversationId: 'sender-chat', title: 'Codex: task' }),
      steerGuard: (_conversationId, _title, expectedEpoch) => {
        epochs.push(expectedEpoch);
        return expectedEpoch === 7
          ? undefined
          : `Forge chat "Codex: task" is on a different chain now (epoch 9, you read ${expectedEpoch}); read it again before steering`;
      },
      interruptForge: async () => ({
        steered: true,
        conversationId: 'sender-chat',
        title: 'Codex: task',
      }),
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const stale = await post(
      '/agent/message?from=codex&to=forge&priority=steer&steer_epoch=5',
      'stop',
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain('different chain');
    expect(stale.body.error).toContain('Nothing was queued');
    // The whole point: `accept` can start the drain in the same tick, so a steer
    // cancelled afterwards is not reliably withdrawn.
    expect(accepted).toEqual([]);
    const current = await post(
      '/agent/message?from=codex&to=forge&priority=steer&steer_epoch=7',
      'stop',
    );
    expect(current.status).toBe(202);
    expect(epochs).toEqual([5, 7]);
    expect(accepted).toHaveLength(1);
  });

  it('refuses a steer_epoch that is not a number, and queues nothing', async () => {
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      resolveChatTarget: () => ({ ok: true, conversationId: 'sender-chat', title: 'Codex: task' }),
      interruptForge: async () => ({
        steered: true,
        conversationId: 'sender-chat',
        title: 'Codex: task',
      }),
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const response = await post(
      '/agent/message?from=codex&to=forge&priority=steer&steer_epoch=recent',
      'stop',
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('steer_epoch');
    expect(accepted).toEqual([]);
  });

  it('names the chat a full inbox left behind, so the owner can find it', async () => {
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: { accept: () => undefined, cancel: () => 0 },
      token: TOKEN,
      chatCapBlockers: () => [],
      openBusChat: async () => ({ ok: true, id: 'worker-3', title: 'Codex: go' }),
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const response = await post('/agent/message?from=forge-x&new_chat=true', 'go');
    expect(response.status).toBe(429);
    // The chat was opened before the inbox was asked, so the refusal names the
    // empty tab it left: otherwise a retry opens a second one behind it.
    expect(response.body.error).toContain('worker-3');
    expect(response.body.error).toContain('open and empty');
  });

  it('passes --unattended through as an inbox option', async () => {
    const response = await post('/agent/message?from=codex&unattended=true', 'audit');
    expect(response.status).toBe(202);
    expect(acceptedOptions[0]).toEqual({ unattended: true });
  });

  it('rejects an unknown model with the configured valid names', async () => {
    const response = await post('/agent/message?from=codex&model=missing', 'nope');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('unknown model "missing"');
    expect(response.body.error).toContain('alpha, beta');
    expect(accepted).toEqual([]);
  });

  it('validates new_chat as a boolean', async () => {
    const response = await post('/agent/message?from=codex&new_chat=maybe', 'nope');
    expect(response.status).toBe(400);
    expect(accepted).toEqual([]);
  });

  it("cancel withdraws only the sender's own queued messages (F3)", async () => {
    await post('/agent/message?from=claude', 'one');
    await post('/agent/message?from=claude', 'two');
    await post('/agent/message?from=codex', 'three');
    expect(await post('/agent/cancel?from=codex&id=m1', '')).toEqual({
      status: 404,
      body: { error: 'no queued message m1 from "codex": unknown, already started, or not yours' },
    });
    expect(await post('/agent/cancel?from=claude&id=m1', '')).toEqual({
      status: 200,
      body: { cancelled: 1 },
    });
    expect((await post('/agent/cancel?from=claude&id=m1', '')).status).toBe(404);
    expect((await post('/agent/cancel?from=claude', '')).status).toBe(400);
    expect(await post('/agent/cancel?from=claude&id=all', '')).toEqual({
      status: 200,
      body: { cancelled: 1 },
    });
    expect([...queuedFrom.keys()]).toEqual(['m3']);
  });

  it('reads the query when the body claims form data and is empty (audit F7)', async () => {
    await post('/agent/message?from=claude', 'one');
    await post('/agent/message?from=claude', 'two');
    // The request an agent types itself instead of running forge.sh: fields in
    // the query string, and a POST whose Content-Type claims form data while
    // its body is empty (curl sets that Content-Type for `-d ''`). The form
    // branch read only the body, so the `from` the request did send went
    // missing and the error blamed the one field that was there (audit F7).
    const noId = await post('/agent/cancel?from=claude', '', {
      type: 'application/x-www-form-urlencoded',
    });
    expect(noId.status).toBe(400);
    expect(noId.body.error).toContain('id is required');
    expect(noId.body.error).not.toContain('from must be');
    const cancelled = await post('/agent/cancel?from=claude&id=m1', '', {
      type: 'application/x-www-form-urlencoded',
    });
    expect(cancelled).toEqual({ status: 200, body: { cancelled: 1 } });
  });

  it('delivers a reply to the waiting question, and the exchange leaves only the shipped files', async () => {
    writeQuestion(paths, 'fg1-abc', 's', 'q');
    const waiting = waitForReply(paths, 'fg1-abc', 5_000, undefined, 10);
    const res = await post('/agent/reply?id=fg1-abc', 'the answer');
    expect(res).toEqual({ status: 200, body: { delivered: true } });
    await expect(waiting).resolves.toBe('the answer');
    clearExchange(paths, 'fg1-abc');
    // The ledger's CI row (AGENT_MESSAGING_PLAN.md): a new durable artifact in
    // the bus folder must get a ledger row and cleanup before this passes.
    expect(fs.readdirSync(paths.root).sort()).toEqual([
      'README.md',
      'endpoint.json',
      'endpoints',
      'forge.sh',
      'inbox',
      'outbox',
    ]);
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
    expect(fs.readdirSync(paths.outbox)).toEqual([]);
  });

  it('says so when a reply reaches a question nobody is waiting on (audit F7)', async () => {
    // `reply` answered `delivered: true` for any well-formed id, whether or not
    // Forge was still waiting for it. The question file is withdrawn the moment
    // the ask ends (answered, timed out or aborted) and swept after 24 h, and
    // nothing reads a reply file after that, so the caller kept an answer that
    // had nowhere to go. It is not written either: the ledger row for the reply
    // outbox says a finished exchange leaves nothing behind.
    const res = await post('/agent/reply?id=nobody-waits', 'the answer');
    expect(res).toEqual({
      status: 200,
      body: { accepted: true, live: false, note: expect.stringContaining('not waiting') },
    });
    expect(fs.existsSync(replyFile(paths, 'nobody-waits'))).toBe(false);
    // The waiting case still answers the way a caller that has an answer to
    // deliver needs: the question file is the record that someone is polling.
    writeQuestion(paths, 'fg3-def', 's', 'q');
    expect(await post('/agent/reply?id=fg3-def', 'the answer')).toEqual({
      status: 200,
      body: { delivered: true },
    });
    clearExchange(paths, 'fg3-def');
  });

  it('refuses other methods and paths', async () => {
    const get = await fetch(`${base}/agent/message`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(405);
    expect((await post('/agent/other', 'x')).status).toBe(404);
  });
});

describe('POST /agent/stop', () => {
  function install(
    stopForge: NonNullable<ConstructorParameters<typeof AgentRoutes>[0]['stopForge']>,
  ): void {
    routes.dispose();
    routes = new AgentRoutes({ paths: () => paths, inbox: stubInbox(), token: TOKEN, stopForge });
    routes.setEnabled(true);
    routes.onListening(base);
  }

  it('stops the resolved default target and returns its chat details', async () => {
    const stopForge = vi.fn(async (from: string, conversationId: string | undefined) => {
      expect(from).toBe('claude');
      expect(conversationId).toBeUndefined();
      return { ok: true as const, conversationId: 'default-chat', title: 'Claude run' };
    });
    install(stopForge);

    expect(await post('/agent/stop?from=claude', '')).toEqual({
      status: 200,
      body: { stopped: true, conversationId: 'default-chat', title: 'Claude run' },
    });
    expect(stopForge).toHaveBeenCalledOnce();
  });

  it('returns 409 for an idle chat and 400 for a closed chat or exchange id', async () => {
    const stopForge = vi.fn(async (_from: string, conversationId: string | undefined) => {
      if (conversationId === 'closed')
        return {
          ok: false as const,
          status: 400 as const,
          error: 'Forge chat "closed" is no longer open',
        };
      if (conversationId === 'exchange-1')
        return { ok: false as const, status: 400 as const, error: 'exchange id is not a chat id' };
      return {
        ok: false as const,
        status: 409 as const,
        error: 'Forge chat "Idle" (idle-chat) is not streaming',
      };
    });
    install(stopForge);

    expect((await post('/agent/stop?from=codex&conversation_id=idle-chat', '')).status).toBe(409);
    expect((await post('/agent/stop?from=codex&conversation_id=closed', '')).status).toBe(400);
    expect((await post('/agent/stop?from=codex&conversation_id=exchange-1', '')).status).toBe(400);
    expect(stopForge).toHaveBeenCalledTimes(3);
  });

  it('requires the token and POST', async () => {
    install(async () => ({ ok: true, conversationId: 'chat', title: 'Chat' }));
    expect((await post('/agent/stop?from=claude', '', { token: null })).status).toBe(401);
    const response = await fetch(`${base}/agent/stop?from=claude`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(405);
  });
});

/** Run the shipped client the way another agent would. Async: the routes
 *  answer from this same process, so a blocking spawn would deadlock. */
function runClient(
  args: string[],
  input: string,
  env: Record<string, string> = {},
  timeoutMs = 20_000,
  cwd?: string,
): Promise<{ code: number; out: string }> {
  const bash = TEST_BASH!;
  return new Promise((resolve) => {
    const child = execFile(
      bash,
      [paths.script.replace(/\\/g, '/'), ...args],
      { timeout: timeoutMs, env: gitBashEnvironment(env), cwd },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === 'number' ? code : 1, out: stdout + stderr });
      },
    );
    child.stdin?.end(input);
  });
}

describe.skipIf(!TEST_BASH)('forge.sh against the routes', () => {
  // Needs a bash that can read this OS's paths and has curl (Git Bash on
  // Windows, not WSL's). Skipped, not failed, where there is none.
  let usable = false;
  beforeAll(async () => {
    const probe = path.join(os.tmpdir(), `forge-bash-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    const bash = TEST_BASH;
    usable =
      !!bash &&
      (await new Promise<boolean>((resolve) =>
        execFile(
          bash,
          ['-c', 'test -f "$1" && command -v curl >/dev/null', '_', probe.replace(/\\/g, '/')],
          { timeout: 10_000, env: gitBashEnvironment() },
          (err) => resolve(!err),
        ),
      ));
    fs.rmSync(probe, { force: true });
  });

  function installClientRoutes(deps: ConstructorParameters<typeof AgentRoutes>[0]): void {
    routes.dispose();
    routes = new AgentRoutes(deps);
    routes.setEnabled(true);
    routes.onListening(base);
  }

  it('say starts a message and reply answers a question', async (ctx) => {
    if (!usable) ctx.skip();
    const said = await runClient(['say', 'claude-review'], 'hello Forge\n');
    expect(said, said.out).toMatchObject({ code: 0 });
    expect(accepted[0]).toContain('**claude-review says:**\n\nhello Forge');
    expect(said.out).toContain('"id":"m1"');
    const cancelled = await runClient(['cancel', 'claude-review', 'm1'], '');
    expect(cancelled.out).toContain('"cancelled":1');
    expect((await runClient(['cancel', 'claude-review', 'm1'], '')).code).toBe(1);

    writeQuestion(paths, 'fg2-abc', 's', 'q');
    const replied = await runClient(['reply', 'fg2-abc'], 'pong\n');
    expect(replied.out).toContain('"delivered":true');
    await expect(waitForReply(paths, 'fg2-abc', 1_000, undefined, 10)).resolves.toBe('pong\n');
  }, 30_000);

  it('who prints bracketed and quoted titles and continues past an older JSON window', async (ctx) => {
    if (!usable) ctx.skip();
    const oldWindowId = '00000000-0000-4000-8000-000000000091';
    const textWindowId = '00000000-0000-4000-8000-000000000092';
    const oldWindow = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"participants":[{"session":"old","attachment":"linked","activity":"idle","detail":"old"}]}');
    });
    const textWindow = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('claude · Job "Maya engine update" [maya-update]\tlinked\tbusy\tMaya [nightly]\n');
    });
    const oldPort = await listenLoopback(oldWindow);
    const textPort = await listenLoopback(textWindow);
    const endpointText = (windowId: string, port: number) =>
      JSON.stringify(
        { windowId, url: `http://127.0.0.1:${port}`, token: TOKEN, pid: process.pid },
        null,
        2,
      );
    fs.rmSync(path.join(paths.root, 'endpoints'), { recursive: true, force: true });
    fs.mkdirSync(path.join(paths.root, 'endpoints'), { recursive: true });
    fs.writeFileSync(
      path.join(paths.root, 'endpoints', `${oldWindowId}.json`),
      endpointText(oldWindowId, oldPort),
    );
    fs.writeFileSync(
      path.join(paths.root, 'endpoints', `${textWindowId}.json`),
      endpointText(textWindowId, textPort),
    );
    try {
      const result = await runClient(['who'], '');
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain(`window ${oldWindowId} runs an older Forge`);
      expect(result.out).toContain('claude · Job "Maya engine update" [maya-update]');
      expect(result.out).toContain('Maya [nightly]');
      expect(result.out).not.toContain('old  ');
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => oldWindow.close(() => resolve())),
        new Promise<void>((resolve) => textWindow.close(() => resolve())),
      ]);
    }
  }, 30_000);

  it('send-file uses the authenticated CLI route without accepting a Forge inbox turn', async (ctx) => {
    if (!usable) ctx.skip();
    const validateAgentSender = vi.fn((sender: { kind: string; sessionId: string }) =>
      sender.kind === 'codex' && sender.sessionId === '00000000-0000-4000-8000-000000000001'
        ? { ok: true as const }
        : { ok: false as const, error: 'unknown linked sender' },
    );
    const sendFile = vi.fn(async () => ({ kind: 'sent' as const }));
    installClientRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      validateAgentSender,
      sendFile,
    });
    const source = path.join(home, 'plan with spaces.md');
    const caption = path.join(home, 'caption with spaces.txt');
    fs.writeFileSync(source, '# approved plan\n');
    fs.writeFileSync(caption, 'owner-approved caption 📎\n');

    const sent = await runClient(
      [
        'send-file',
        'codex',
        '--to',
        'sender-chat',
        'plan with spaces.md',
        '--caption-file',
        caption,
      ],
      '',
      { CODEX_SESSION_ID: '00000000-0000-4000-8000-000000000001' },
    );

    expect(sent.code).toBe(0);
    expect(sent.out).toContain('"sent":true');
    expect(validateAgentSender).toHaveBeenCalledWith({
      kind: 'codex',
      sessionId: '00000000-0000-4000-8000-000000000001',
    });
    expect(sendFile).toHaveBeenCalledWith(
      'codex',
      { kind: 'codex', sessionId: '00000000-0000-4000-8000-000000000001' },
      'sender-chat',
      'plan with spaces.md',
      'owner-approved caption 📎\n',
    );
    expect(accepted).toEqual([]);
  }, 30_000);

  it('send-file refuses invalid sender, caption, extra fields, and query parameters before upload', async () => {
    const sendFile = vi.fn(async () => ({ kind: 'sent' as const }));
    installClientRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      validateAgentSender: (sender) =>
        sender.kind === 'codex' && sender.sessionId === '00000000-0000-4000-8000-000000000001'
          ? { ok: true }
          : { ok: false, error: 'unknown linked sender' },
      sendFile,
    });
    const identity = {
      sender_kind: 'codex',
      sender_session_id: '00000000-0000-4000-8000-000000000001',
    };
    const request = (fields: Record<string, unknown>, query = '') =>
      post(`/agent/send-file${query}`, JSON.stringify({ ...identity, ...fields }), {
        type: 'application/json',
      });

    expect(
      (
        await post(
          '/agent/send-file',
          JSON.stringify({ from: 'codex', conversation_id: 'c1', path: 'plan.md' }),
          { token: 'wrong-token', type: 'application/json' },
        )
      ).status,
    ).toBe(401);
    expect(
      (await request({ from: 'mallory', conversation_id: 'c1', path: 'plan.md' })).status,
    ).toBe(400);
    expect(
      (
        await request({
          from: 'codex',
          conversation_id: 'c1',
          path: 'plan.md',
          caption: '📎'.repeat(1025),
        })
      ).status,
    ).toBe(400);
    expect(
      (await request({ from: 'codex', conversation_id: 'c1', path: 'plan.md', chat_id: 'x' }))
        .status,
    ).toBe(400);
    expect(
      (await request({ from: 'codex', conversation_id: 'c1', path: 'plan.md' }, '?chat_id=x'))
        .status,
    ).toBe(400);
    expect(sendFile).not.toHaveBeenCalled();
    expect(accepted).toEqual([]);
  });

  it('say parses --model and --new into the generated request', async (ctx) => {
    if (!usable) ctx.skip();
    const said = await runClient(
      ['say', '--model', 'alpha', '--new', 'claude-review'],
      'new chat\n',
    );
    expect(said.code).toBe(0);
    expect(acceptedOptions[0]).toEqual({ model: 'alpha', newChat: true });
  }, 30_000);

  it('stop sends no turn text, accepts --to, and exits non-zero for a 409', async (ctx) => {
    if (!usable) ctx.skip();
    const stopped: Array<string | undefined> = [];
    installClientRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      stopForge: async (_from, conversationId) => {
        stopped.push(conversationId);
        if (conversationId === 'idle-chat') {
          return {
            ok: false,
            status: 409,
            error: 'Forge chat "Idle" (idle-chat) is not streaming',
          };
        }
        return {
          ok: true,
          conversationId: conversationId ?? 'default-chat',
          title: 'Bus stop test',
        };
      },
    });
    const env = { CODEX_SESSION_ID: '00000000-0000-4000-8000-000000000001' };

    const defaultStop = await runClient(['stop', 'codex'], 'ignored input', env);
    const targetedStop = await runClient(['stop', 'codex', '--to', 'target-chat'], '', env);
    const idleStop = await runClient(['stop', 'codex', '--to', 'idle-chat'], '', env);

    expect(defaultStop.code).toBe(0);
    expect(defaultStop.out).toContain('"stopped":true');
    expect(targetedStop.code).toBe(0);
    expect(targetedStop.out).toContain('"conversationId":"target-chat"');
    expect(idleStop.code).toBe(1);
    expect(idleStop.out).toContain('not streaming');
    expect(stopped).toEqual([undefined, 'target-chat', 'idle-chat']);
    expect(accepted).toEqual([]);
  }, 30_000);

  it('steer targeting and stop argument errors are checked before a request', async (ctx) => {
    if (!usable) ctx.skip();
    const results = await Promise.all([
      runClient(['steer', 'codex', 'codex', '--to', 'chat'], 'text'),
      runClient(['steer', 'codex', 'forge', '--to', 'chat', '--to-running'], 'text'),
      runClient(['stop', 'codex', 'unexpected'], ''),
    ]);
    expect(results.map((result) => result.code)).toEqual([2, 2, 2]);
    expect(accepted).toEqual([]);
  }, 30_000);

  it('requires the declared kind session variable before an agent say', async (ctx) => {
    if (!usable) ctx.skip();
    const said = await runClient(['say', 'codex'], 'message\n', { CODEX_SESSION_ID: '' });
    expect(said.code).toBe(2);
    expect(said.out).toContain('CODEX_SESSION_ID');
    expect(accepted).toEqual([]);
  }, 30_000);

  it('skips an unreachable window endpoint and posts to the endpoint that holds the session', async (ctx) => {
    if (!usable) ctx.skip();
    const pending = new PendingAgentReplies(paths.root);
    installClientRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      pendingReplies: pending,
      workspaceRoot: '/workspace',
      holdsLink: () => true,
      resolveInboundAgent: async (sender) => ({
        conversationId: 'holder-chat',
        title: 'Holder chat',
        sender: { ...sender, title: 'Codex session' },
        link: {
          ...sender,
          cwd: '/workspace',
          title: 'Codex session',
          linkedAt: 1,
          lastUsedAt: 1,
          origin: 'first-inbound',
        },
      }),
    });
    fs.rmSync(path.join(paths.root, 'endpoints'), { recursive: true, force: true });
    fs.mkdirSync(path.join(paths.root, 'endpoints'), { recursive: true });
    const endpoint = (windowId: string, url: string) => ({
      windowId,
      url,
      token: TOKEN,
      pid: 2_000_000_000,
    });
    fs.writeFileSync(
      path.join(paths.root, 'endpoints', '00000000-0000-4000-8000-000000000001.json'),
      JSON.stringify(
        endpoint('00000000-0000-4000-8000-000000000001', 'http://127.0.0.1:1'),
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(paths.root, 'endpoints', '00000000-0000-4000-8000-000000000002.json'),
      JSON.stringify(endpoint('00000000-0000-4000-8000-000000000002', base), null, 2),
    );
    fs.writeFileSync(
      paths.endpoint,
      JSON.stringify(
        endpoint('00000000-0000-4000-8000-000000000003', 'http://127.0.0.1:1'),
        null,
        2,
      ),
    );

    const said = await runClient(['say', 'codex'], 'check holder routing\n', {
      CODEX_SESSION_ID: '00000000-0000-4000-8000-000000000099',
    });
    expect(said.code, said.out).toBe(0);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toContain('check holder routing');
    expect(said.out).toContain(
      '"receipt":"Forge received your message (chat \\\"Holder chat\\\")"',
    );
  }, 30_000);

  it(
    'routes every read verb to the window holding the sender link, not the focused one',
    async (ctx) => {
      if (!usable) ctx.skip();
      // Two windows: A holds this session's link, B is `endpoint.json` (the
      // focused one). Every read verb used to read from B, so `status` answered
      // for a window that never held the session — the live defect the owner
      // reported with two windows open: `status claude` said `no chat holds a
      // message from "claude"` while `say --to` reached the right chats.
      routes.dispose();
      const EP_ID = '00000000-0000-4000-8000-0000000000a1';
      const calls: Record<'window-a' | 'window-b', string[]> = {
        'window-a': [],
        'window-b': [],
      };
      const readQueries: string[] = [];
      const windows: http.Server[] = [];
      const listenWindow = async (name: 'window-a' | 'window-b'): Promise<string> => {
        const windowServer = http.createServer((req, res) => {
          const route = new URL(req.url ?? '/', 'http://localhost').pathname;
          calls[name].push(route);
          if (route === '/agent/status' || route === '/agent/view')
            readQueries.push(req.url ?? '');
          if (route === '/agent/holds-link') {
            res.end(JSON.stringify({ holdsLink: name === 'window-a', cwdMatch: 0 }));
            return;
          }
          if (route === '/agent/status') {
            res.end('State: idle\nQueued from you: 0\n');
            return;
          }
          if (route === '/agent/view') {
            res.end('the latest answer\n');
            return;
          }
          if (route === '/agent/read-verdict') {
            res.end('the full verdict\n');
            return;
          }
          if (route === '/agent/ack-verdict') {
            res.end('{"acknowledged":true}');
            return;
          }
          if (route === '/agent/send-file') {
            res.end('{"sent":true}');
            return;
          }
          res.writeHead(404).end('{"error":"not found"}');
        });
        const port = await listenLoopback(windowServer);
        windows.push(windowServer);
        return `http://127.0.0.1:${port}`;
      };
      const endpoint = (url: string) =>
        JSON.stringify({ windowId: EP_ID, url, token: TOKEN, pid: process.pid }, null, 2);
      try {
        const windowA = await listenWindow('window-a');
        const windowB = await listenWindow('window-b');
        fs.rmSync(path.join(paths.root, 'endpoints'), { recursive: true, force: true });
        fs.mkdirSync(path.join(paths.root, 'endpoints'), { recursive: true });
        // The focused window owns endpoint.json and its own file in endpoints/,
        // so a read that falls back to endpoint.json would land on a window that
        // was already probed for the link. Here that window is B, and the holder
        // is A, so no read goes to either one twice.
        fs.writeFileSync(paths.endpoint, endpoint(windowB));
        fs.writeFileSync(path.join(paths.root, 'endpoints', 'window-a.json'), endpoint(windowA));
        fs.writeFileSync(path.join(paths.root, 'endpoints', 'window-b.json'), endpoint(windowB));
        fs.writeFileSync(path.join(home, 'read-routing-file.md'), 'approved file\n');
        const env = { CODEX_SESSION_ID: '00000000-0000-4000-8000-000000000001' };

        const runs = [
          await runClient(['status', 'codex', '--to', 'chat-1'], '', env),
          await runClient(['view', 'codex', '--to', 'chat-1'], '', env),
          await runClient(['wait', 'codex', '1'], '', env),
          await runClient(['read-verdict', 'codex', 'exchange-1'], '', env),
          await runClient(['ack-verdict', 'codex', 'exchange-1'], '', env),
          await runClient(
            ['send-file', 'codex', '--to', 'chat-1', 'read-routing-file.md'],
            '',
            env,
            20_000,
            home,
          ),
        ];
        const badTarget = await runClient(['status', 'codex', '--to', 'bad/id'], '', env);

        for (const run of runs) expect(run.code, run.out).toBe(0);
        expect(badTarget.code).toBe(2);
        expect(badTarget.out).toContain('bad conversation id');
        // Every read reached the holder, including `wait`, which polls `status`
        // and then prints `view`.
        for (const route of [
          '/agent/status',
          '/agent/view',
          '/agent/read-verdict',
          '/agent/ack-verdict',
          '/agent/send-file',
        ])
          expect(calls['window-a'], calls['window-a'].join(' ')).toContain(route);
        expect(readQueries).toEqual(
          expect.arrayContaining([
            expect.stringContaining(
              '/agent/status?from=codex&kind=codex&sessionId=00000000-0000-4000-8000-000000000001&conversation_id=chat-1',
            ),
            expect.stringContaining(
              '/agent/view?from=codex&kind=codex&sessionId=00000000-0000-4000-8000-000000000001&conversation_id=chat-1',
            ),
          ]),
        );
        // The focused window was only ever asked whether it holds the link:
        // no read went to it, and nothing was refused because of it.
        expect(calls['window-b'].every((route) => route === '/agent/holds-link')).toBe(true);
        expect(calls['window-b']).toHaveLength(runs.length);
      } finally {
        fs.rmSync(path.join(paths.root, 'endpoints'), { recursive: true, force: true });
        await Promise.all(
          windows.map((windowServer) => new Promise<void>((resolve) => windowServer.close(() => resolve()))),
        );
      }
    },
    45_000,
  );

  it('who lists each live window once and skips an unreachable endpoint', async (ctx) => {
    if (!usable) ctx.skip();
    routes.dispose();
    const EP_ID = '00000000-0000-4000-8000-0000000000a1';
    const calls: string[] = [];
    const windows: http.Server[] = [];
    const listenWindow = async (label: string): Promise<string> => {
      const windowServer = http.createServer((req, res) => {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        calls.push(`${label}:${requestUrl.pathname}${requestUrl.search}`);
        const participant = (session: string) => ({
          session,
          attachment: 'linked',
          activity: 'idle',
          detail: `${session} chat`,
        });
        const participants =
          label === 'window-a'
            ? [
                participant('codex · Build'),
                participant('codex · Build'),
                participant('claude · Review'),
              ]
            : [participant('claude · Review'), participant('claude · Review')];
        if (requestUrl.searchParams.get('format') === 'text') {
          res.end(
            participants
              .map(({ session, attachment, activity, detail }) =>
                [session, attachment, activity, detail].join('\t'),
              )
              .join('\n'),
          );
        } else {
          res.end(JSON.stringify({ participants }));
        }
      });
      const port = await listenLoopback(windowServer);
      windows.push(windowServer);
      return `http://127.0.0.1:${port}`;
    };
    const endpoint = (url: string) =>
      JSON.stringify({ windowId: EP_ID, url, token: TOKEN, pid: process.pid }, null, 2);
    const writeEndpoints = (files: Record<string, string>): void => {
      fs.rmSync(path.join(paths.root, 'endpoints'), { recursive: true, force: true });
      fs.mkdirSync(path.join(paths.root, 'endpoints'), { recursive: true });
      for (const [name, url] of Object.entries(files))
        fs.writeFileSync(path.join(paths.root, 'endpoints', `${name}.json`), endpoint(url));
    };
    try {
      const windowA = await listenWindow('window-a');
      const windowB = await listenWindow('window-b');
      writeEndpoints({
        'window-a': windowA,
        'window-b': windowB,
        unreachable: 'http://127.0.0.1:1',
      });
      // The focused window is B, and it is also in endpoints/: its rows would
      // print twice without the dedupe, and the dead file must not stop it.
      fs.writeFileSync(paths.endpoint, endpoint(windowB));

      const who = await runClient(['who'], '');
      expect(who.code, who.out).toBe(0);
      const rows = who.out.trim().split(/\r?\n/u);
      expect(rows.filter((row) => row.includes('codex') && row.includes('Build'))).toHaveLength(1);
      expect(rows.filter((row) => row.includes('claude') && row.includes('Review'))).toHaveLength(
        1,
      );
      expect(who.out).toContain('Review chat');
      expect(calls.filter((call) => call.includes(':/agent/who?'))).toEqual([
        'window-a:/agent/who?format=text',
        'window-b:/agent/who?format=text',
      ]);

      // Every endpoint file present and none of them answers: that is a failure
      // with a reason, not an empty success an agent would read as "nothing is
      // linked", which is what it used to be.
      writeEndpoints({ 'dead-a': 'http://127.0.0.1:1', 'dead-b': 'http://127.0.0.1:2' });
      const dead = await runClient(['who'], '');
      expect(dead.code).toBe(1);
      expect(dead.out).toContain('not reachable');

      // No endpoints/ folder at all: endpoint.json is still read on its own,
      // and the window that is not written there is not asked.
      fs.rmSync(path.join(paths.root, 'endpoints'), { recursive: true, force: true });
      fs.writeFileSync(paths.endpoint, endpoint(windowA));
      const fallback = await runClient(['who'], '');
      expect(fallback.code, fallback.out).toBe(0);
      expect(fallback.out).toContain('Build chat');
      expect(calls.filter((call) => call.includes(':/agent/who?'))).toEqual([
        'window-a:/agent/who?format=text',
        'window-b:/agent/who?format=text',
        'window-a:/agent/who?format=text',
      ]);
    } finally {
      fs.rmSync(path.join(paths.root, 'endpoints'), { recursive: true, force: true });
      await Promise.all(
        windows.map((windowServer) => new Promise<void>((resolve) => windowServer.close(() => resolve()))),
      );
    }
  }, 45_000);

  it('who prints two rows of one session when they name different chats', async (ctx) => {
    if (!usable) ctx.skip();
    // Since one agent session may hold several Forge chats (977ffbed), `who`
    // answers with one row per linked chat: the same `session` column, a
    // different chat title in the last one. Deduping by `session` alone hides
    // every chat after the first, so the key has to be the whole printed line
    // — which still collapses a window that answers through two files.
    routes.dispose();
    const EP_ID = '00000000-0000-4000-8000-0000000000a1';
    const asked: string[] = [];
    const windows: http.Server[] = [];
    const windowServer = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      asked.push(`${requestUrl.pathname}${requestUrl.search}`);
      const row = (detail: string) => ({
        session: 'codex · Build',
        attachment: 'linked',
        activity: 'idle',
        detail,
      });
      const participants = [row('Build chat'), row('Second chat'), row('Build chat')];
      if (requestUrl.searchParams.get('format') === 'text') {
        res.end(
          participants
            .map(({ session, attachment, activity, detail }) =>
              [session, attachment, activity, detail].join('\t'),
            )
            .join('\n'),
        );
      } else {
        res.end(JSON.stringify({ participants }));
      }
    });
    try {
      const port = await listenLoopback(windowServer);
      windows.push(windowServer);
      const endpoint = JSON.stringify(
        {
          windowId: EP_ID,
          url: `http://127.0.0.1:${port}`,
          token: TOKEN,
          pid: process.pid,
        },
        null,
        2,
      );
      fs.rmSync(path.join(paths.root, 'endpoints'), { recursive: true, force: true });
      fs.mkdirSync(path.join(paths.root, 'endpoints'), { recursive: true });
      // Two files naming the same live window: the window is asked twice, and
      // its repeated rows still print once, while its two chats print twice.
      fs.writeFileSync(path.join(paths.root, 'endpoints', 'window-a.json'), endpoint);
      fs.writeFileSync(path.join(paths.root, 'endpoints', 'window-b.json'), endpoint);
      fs.writeFileSync(paths.endpoint, endpoint);

      const who = await runClient(['who'], '');
      expect(who.code, who.out).toBe(0);
      const rows = who.out.trim().split(/\r?\n/u);
      expect(rows).toHaveLength(2);
      expect(who.out).toContain('Second chat');
      expect(rows.filter((row) => row.includes('Build chat'))).toHaveLength(1);
      expect(asked).toEqual(['/agent/who?format=text', '/agent/who?format=text']);
    } finally {
      fs.rmSync(path.join(paths.root, 'endpoints'), { recursive: true, force: true });
      await Promise.all(
        windows.map((windowServer) => new Promise<void>((resolve) => windowServer.close(() => resolve()))),
      );
    }
  }, 30_000);

  it('sends an unlinked session to the window whose workspace holds its folder, not the focused one', async (ctx) => {
    if (!usable) ctx.skip();
    const repo = path.join(home, 'repo');
    const inside = path.join(repo, 'src');
    fs.mkdirSync(inside, { recursive: true });
    installClientRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      pendingReplies: new PendingAgentReplies(paths.root),
      workspaceRoot: repo,
      holdsLink: () => false,
      resolveInboundAgent: async (sender) => ({
        conversationId: 'repo-chat',
        title: 'Repo chat',
        sender: { ...sender, title: 'Claude session' },
        link: {
          ...sender,
          cwd: repo,
          title: 'Claude session',
          linkedAt: 1,
          lastUsedAt: 1,
          origin: 'first-inbound',
        },
      }),
    });
    fs.rmSync(path.join(paths.root, 'endpoints'), { recursive: true, force: true });
    fs.mkdirSync(path.join(paths.root, 'endpoints'), { recursive: true });
    const endpoint = (windowId: string, url: string) =>
      JSON.stringify({ windowId, url, token: TOKEN, pid: 2_000_000_000 }, null, 2);
    const repoWindow = '00000000-0000-4000-8000-000000000002';
    fs.writeFileSync(
      path.join(paths.root, 'endpoints', `${repoWindow}.json`),
      endpoint(repoWindow, base),
    );
    // The focused window (endpoint.json) is unreachable: choosing it fails.
    fs.writeFileSync(
      paths.endpoint,
      endpoint('00000000-0000-4000-8000-000000000003', 'http://127.0.0.1:1'),
    );
    const env = { CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-000000000098' };

    const said = await runClient(
      ['say', 'claude', '--new'],
      'from the repo\n',
      env,
      20_000,
      inside,
    );
    expect(said.code, said.out).toBe(0);
    expect(accepted).toHaveLength(1);
    expect(said.out).toContain('Repo chat');

    const outside = await runClient(
      ['say', 'claude', '--new'],
      'from elsewhere\n',
      env,
      20_000,
      home,
    );
    expect(outside.code, outside.out).not.toBe(0);
    expect(accepted).toHaveLength(1);
  }, 30_000);

  it('writes a durable pending reply before accepting an agent turn', async () => {
    const pending = new PendingAgentReplies(paths.root);
    let acceptedWithPending = false;
    routes.dispose();
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: {
        accept: () => {
          acceptedWithPending = pending.list().length === 1;
          return { position: 1, id: 'm-agent' };
        },
        cancel: () => 0,
      },
      token: TOKEN,
      pendingReplies: pending,
      workspaceRoot: '/workspace',
      isChatBusy: () => true,
      recordPendingAccepted: async (record) => {
        expect(pending.list()).toContainEqual(record);
        expect(acceptedWithPending).toBe(false);
      },
      resolveInboundAgent: async (sender) => ({
        conversationId: 'chat-agent',
        title: 'Inbound chat',
        sender: { ...sender, title: 'Codex session' },
        link: {
          ...sender,
          cwd: '/workspace',
          title: 'Codex session',
          linkedAt: 1,
          lastUsedAt: 1,
          origin: 'first-inbound',
        },
      }),
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const sender = encodeURIComponent(
      JSON.stringify({
        kind: 'codex',
        sessionId: '00000000-0000-4000-8000-000000000061',
      }),
    );
    const response = await post(`/agent/message?from=codex&sender=${sender}`, 'Review the patch');
    expect(response.status).toBe(202);
    expect(acceptedWithPending).toBe(true);
    expect(pending.list()[0]).toMatchObject({
      conversationId: 'chat-agent',
      workspace: '/workspace',
      state: 'admitted',
    });
    expect(response.body.receipt).toBe(
      'Forge received your message (chat "Inbound chat") — queued behind the running turn',
    );
  });

  it('agent send relays by linked session kind', async (ctx) => {
    if (!usable) ctx.skip();
    const agentRelays: [string, string, string][] = [];
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: { accept: () => ({ position: 1, id: 'm1' }), cancel: () => 0 },
      token: TOKEN,
      relayAgent: async (sender, to, text) => (
        agentRelays.push([sender.kind, to, text]),
        { ok: true, exchangeId: 'agent-x1', deliveredTo: 'Codex linked chat' }
      ),
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const sent = await runClient(['send', 'claude', 'codex'], 'plan ready\n', {
      FORGE_CONVERSATION_ID: 'origin-chat-7',
      CLAUDE_CODE_SESSION_ID: '8e395649-705e-47f9-b499-03a36e908f50',
    });
    expect(JSON.parse(sent.out.trim())).toMatchObject({
      relayed: true,
      exchangeId: 'agent-x1',
      delivered_to: 'Codex linked chat',
      message:
        'Sent as exchange agent-x1. The verdict wakes the sending Forge chat when it is open ' +
        '(when the send came from a Forge chat). Use `wait` and then `read-verdict` for the full response.',
    });
    expect(agentRelays).toEqual([['claude', 'codex', 'plan ready\n']]);
    const invalid = await runClient(['send', 'claude', 'codex'], 'still sent\n', {
      FORGE_CONVERSATION_ID: 'bad/id',
      CLAUDE_CODE_SESSION_ID: '8e395649-705e-47f9-b499-03a36e908f50',
    });
    expect(invalid.code).toBe(0);
    expect(invalid.out.match(/invalid FORGE_CONVERSATION_ID/g)).toHaveLength(1);
    expect(agentRelays[1]).toEqual(['claude', 'codex', 'still sent\n']);
  }, 30_000);

  it('steer to forge queues at the front and interrupts the running turn (§6)', async (ctx) => {
    if (!usable) ctx.skip();
    const calls: string[] = [];
    const targets: string[] = [];
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: {
        accept: (_prompt, _from, front, options) => (
          calls.push(`accept front=${String(front)}`),
          targets.push(options?.targetConversationId ?? 'default'),
          { position: 1, id: 'm1' }
        ),
        cancel: () => 0,
      },
      token: TOKEN,
      resolveChatTarget: (_from, selection) => ({
        ok: true,
        conversationId: selection.conversationId ?? 'sender-chat',
        title: selection.conversationId === 'target-chat' ? 'Named chat' : 'Codex: task',
      }),
      interruptForge: async (_from, conversationId) => {
        calls.push(`interrupt ${conversationId ?? 'default'}`);
        return {
          steered: true,
          conversationId: conversationId ?? 'sender-chat',
          title: conversationId === 'target-chat' ? 'Named chat' : 'Codex: task',
        };
      },
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const steered = await runClient(['steer', 'claude-review', 'forge'], 'use ask_agent');
    expect(JSON.parse(steered.out.trim())).toMatchObject({
      queued: expect.any(Number),
      id: expect.any(String),
      steered: true,
      conversationId: 'sender-chat',
      title: 'Codex: task',
    });
    expect(calls).toEqual(['accept front=true', 'interrupt sender-chat']);
    const targetedSteer = await runClient(
      ['steer', 'claude-review', 'forge', '--to', 'target-chat'],
      'targeted correction',
    );
    expect(JSON.parse(targetedSteer.out.trim())).toMatchObject({
      steered: true,
      conversationId: 'target-chat',
      title: 'Named chat',
    });
    expect(calls.slice(2)).toEqual(['accept front=true', 'interrupt target-chat']);
    expect(targets).toEqual(['sender-chat', 'target-chat']);
    const said = await runClient(['say', 'claude-review'], 'plain');
    expect(said.out).toContain('"queued"');
    expect(calls.slice(4)).toEqual(['accept front=false']);
  }, 30_000);

  it('say/send support an explicit chat target and --to-running', async (ctx) => {
    if (!usable) ctx.skip();
    const delivered: unknown[] = [];
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: {
        accept: (_prompt, _from, _front, options) => (
          delivered.push(options),
          { position: delivered.length, id: `m${delivered.length}` }
        ),
        cancel: () => 0,
      },
      token: TOKEN,
      resolveChatTarget: (_from, selection) => ({
        ok: true,
        conversationId: selection.conversationId ?? 'running-chat',
        title: 'Q6 investigation',
      }),
    });
    routes.setEnabled(true);
    routes.onListening(base);

    const said = await runClient(
      ['say', 'codex-peer', '--to', 'sender-chat'],
      'direct follow-up\n',
    );
    const sent = await runClient(
      ['send', 'codex-peer', 'forge', '--to-running'],
      'interrupt context\n',
    );

    expect(said.code).toBe(0);
    expect(said.out).toContain('"conversationId":"sender-chat"');
    expect(sent.code).toBe(0);
    expect(sent.out).toContain('"conversationId":"running-chat"');
    expect(delivered).toEqual([
      expect.objectContaining({ targetConversationId: 'sender-chat' }),
      expect.objectContaining({ toRunning: true, targetConversationId: 'running-chat' }),
    ]);
  }, 30_000);

  it('refuses a bad id or name before sending anything', async (ctx) => {
    if (!usable) ctx.skip();
    const results = await Promise.all([
      runClient(['reply', '../x'], 'a'),
      runClient(['say', 'a b'], 'a'),
      runClient(['cancel', 'x', '../m1'], ''),
      runClient(['cancel', 'x'], ''),
    ]);
    expect(results.map((result) => result.code)).toEqual([2, 2, 2, 2]);
    expect(accepted).toEqual([]);
  }, 30_000);

  it('does not retain the removed reply-in-chat option', async (ctx) => {
    if (!usable) ctx.skip();
    const said = await runClient(['say', 'claude-review', '--reply-in-chat'], 'question\n');
    expect(said.code).toBe(2);
    expect(accepted).toEqual([]);
  }, 30_000);

  it('a reply still lands through the outbox file when Forge is gone; a message does not', async (ctx) => {
    if (!usable) ctx.skip();
    routes.dispose();
    const replied = await runClient(['reply', 'fg3-abc'], 'offline answer');
    expect(replied).toMatchObject({ code: 0 });
    await expect(waitForReply(paths, 'fg3-abc', 1_000, undefined, 10)).resolves.toBe(
      'offline answer',
    );
    const said = await runClient(['say', 'x'], 'hi');
    expect(said.code).toBe(1);
    expect(said.out).toContain('not reachable');
  }, 30_000);

  it('wait: refuses bad names, timeout arguments, and env overrides before any request', async (ctx) => {
    if (!usable) ctx.skip();
    const results = await Promise.all([
      runClient(['wait', 'a b'], ''),
      runClient(['wait', 'x', 'abc'], ''),
      runClient(['wait', 'x', '0'], ''),
      runClient(['wait', 'x', '100001'], ''),
      runClient(['wait', 'x', '1', 'extra'], ''),
      runClient(['wait', 'x'], '', { FORGE_WAIT_POLL_MS: 'nope' }),
      runClient(['wait', 'x'], '', { FORGE_WAIT_POLL_MS: '0' }),
      runClient(['wait', 'x'], '', { FORGE_WAIT_TIMEOUT_SECONDS: 'nope' }),
      runClient(['wait', 'x'], '', { FORGE_WAIT_TIMEOUT_SECONDS: '0' }),
    ]);
    expect(results.map((result) => result.code)).toEqual(Array(9).fill(2));
    expect(accepted).toEqual([]);
  }, 30_000);

  it('wait: exits 1 when the endpoint is gone (no endpoint.json)', async (ctx) => {
    if (!usable) ctx.skip();
    routes.dispose();
    const res = await runClient(['wait', 'x'], '');
    expect(res.code).toBe(1);
    expect(res.out).toContain('not reachable');
  }, 30_000);

  it('wait: exits 1 when the endpoint rejects the request', async (ctx) => {
    if (!usable) ctx.skip();
    installClientRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      status: () => ({ ok: false, status: 404, error: 'no chat' }),
    });
    const res = await runClient(
      ['wait', 'x'],
      '',
      { FORGE_WAIT_POLL_MS: '1', FORGE_WAIT_TIMEOUT_SECONDS: '1' },
      10_000,
    );
    expect(res.code).toBe(1);
    expect(res.out).toContain("Forge's endpoint did not accept it");
  }, 30_000);

  it('wait: busy -> idle/no-queue completes and prints the final status and the latest answer', async (ctx) => {
    if (!usable) ctx.skip();
    let polls = 0;
    installClientRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      status: () => {
        polls += 1;
        const idle = polls >= 2;
        return {
          ok: true,
          text:
            `Chat: t · c1\n` +
            `State: ${idle ? 'idle' : 'busy · turn running 1 s · last activity 0 s ago'}\n` +
            `Model: m\n` +
            `Context: 1/2\n` +
            `Queued from you: 0\n` +
            `Work: 1 model request(s), 0 tool call(s), 0 compaction(s) in this chat`,
        };
      },
      view: () => ({ ok: true, text: 'the answer' }),
    });
    const res = await runClient(['wait', 'x'], '', { FORGE_WAIT_POLL_MS: '1' }, 10_000);
    expect(res.code, res.out).toBe(0);
    expect(res.out).toContain('State: idle');
    expect(res.out).toContain('Queued from you: 0');
    expect(res.out).toContain('the answer');
    expect(polls).toBe(2);
  }, 30_000);

  it('wait: idle with a queue keeps polling until the queue drains', async (ctx) => {
    if (!usable) ctx.skip();
    let polls = 0;
    installClientRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      status: () => {
        polls += 1;
        const drained = polls >= 3;
        return {
          ok: true,
          text:
            `Chat: t · c1\n` +
            `State: idle\n` +
            `Model: m\n` +
            `Context: 1/2\n` +
            `Queued from you: ${drained ? 0 : 2}\n` +
            `Work: 1 model request(s), 0 tool call(s), 0 compaction(s) in this chat`,
        };
      },
      view: () => ({ ok: true, text: 'the answer' }),
    });
    const res = await runClient(['wait', 'x'], '', { FORGE_WAIT_POLL_MS: '1' }, 10_000);
    expect(res.code, res.out).toBe(0);
    expect(res.out).toContain('Queued from you: 0');
    expect(res.out).toContain('the answer');
    expect(polls).toBe(3);
  }, 30_000);

  it('wait: does not mistake busy narration for the state and queue fields', async (ctx) => {
    if (!usable) ctx.skip();
    let polls = 0;
    installClientRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      status: () => {
        polls += 1;
        return {
          ok: true,
          text:
            `Chat: t · c1\n` +
            `State: ${polls >= 2 ? 'idle' : 'busy · turn running 1 s'}\n` +
            `Said: State: idle; Queued from you: 0\n` +
            `Queued from you: 0`,
        };
      },
      view: () => ({ ok: true, text: 'the answer' }),
    });
    const res = await runClient(['wait', 'x'], '', { FORGE_WAIT_POLL_MS: '1' }, 10_000);
    expect(res.code, res.out).toBe(0);
    expect(polls).toBe(2);
  }, 30_000);

  it('wait: a timed-out wait prints the last status to stderr and exits 124', async (ctx) => {
    if (!usable) ctx.skip();
    installClientRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      status: () => ({
        ok: true,
        text:
          `Chat: t · c1\n` +
          `State: busy · turn running 1 s · last activity 0 s ago\n` +
          `Model: m\n` +
          `Context: 1/2\n` +
          `Queued from you: 0\n` +
          `Work: 1 model request(s), 0 tool call(s), 0 compaction(s) in this chat`,
      }),
    });
    const res = await runClient(
      ['wait', 'x', '1'],
      '',
      {
        FORGE_WAIT_TIMEOUT_SECONDS: '1',
        FORGE_WAIT_POLL_MS: '1',
      },
      10_000,
    );
    expect(res.code).toBe(124);
    expect(res.out).toContain('still not idle after 1 minute(s); last status:');
    expect(res.out).toContain('State: busy');
  }, 30_000);
});

describe('sender validation and relay gating (M6/§4)', () => {
  // Reassign the module-level `routes` (the server closure reads it by name)
  // and re-enable it, since beforeEach enabled the original instance.
  function install(deps: ConstructorParameters<typeof AgentRoutes>[0]): void {
    routes = new AgentRoutes(deps);
    routes.setEnabled(true);
    routes.onListening(base);
  }

  it('rejects an unknown `from` with the live list, before the inbox', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      validateFrom: (from) =>
        from === 'codex' || from === 'forge'
          ? { ok: true }
          : { ok: false, error: `unknown sender "${from}"; live aliases: codex` },
    });
    const { status, body } = await post('/agent/message?from=mallory', 'hi');
    expect(status).toBe(400);
    expect(body.error).toContain('mallory');
    expect(accepted).toEqual([]);
  });

  it('accepts a known `from` and delivers to the inbox', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      validateFrom: (from) => (from === 'codex' ? { ok: true } : { ok: false, error: 'no' }),
    });
    const { status } = await post('/agent/message?from=codex', 'hi');
    expect(status).toBe(202);
    expect(accepted).toHaveLength(1);
  });

  it('rejects a non-Forge `to` when no relay is installed (no silent inbox delivery)', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      validateFrom: () => ({ ok: true }),
      // no relay
    });
    const { status, body } = await post('/agent/message?from=codex&to=claude', 'hi');
    expect(status).toBe(400);
    expect(body.error).toContain('no relay');
    expect(accepted).toEqual([]);
  });
});

describe('relay origin conversation (2b)', () => {
  it('passes origin_conversation to the relay and rejects it for to=forge', async () => {
    routes.dispose();
    const relay = vi.fn(async (_from: string, _to: string, _text: string, _origin?: string) => ({
      ok: true as const,
      exchangeId: 'exchange-1',
    }));
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      validateFrom: () => ({ ok: true }),
      relay,
    });
    routes.setEnabled(true);
    routes.onListening(base);

    const relayed = await post(
      '/agent/message?from=codex&to=claude&origin_conversation=chat-7',
      'review this',
    );
    expect(relayed.status).toBe(202);
    expect(relay).toHaveBeenCalledWith('codex', 'claude', 'review this', 'chat-7');

    const forge = await post(
      '/agent/message?from=codex&to=forge&origin_conversation=chat-7',
      'review this',
    );
    expect(forge.status).toBe(400);
    expect(forge.body.error).toContain('origin_conversation');
  });
});

describe('GET /agent/who', () => {
  function install(deps: ConstructorParameters<typeof AgentRoutes>[0]): void {
    routes = new AgentRoutes(deps);
    routes.setEnabled(true);
    routes.onListening(base);
  }
  const get = (route: string, token: string | null = TOKEN): Promise<Response> =>
    fetch(`${base}${route}`, {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });

  it('A6: 401 without a token, 404 while disabled, 200 with the token', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      who: () => [
        { session: 'claude · Review', attachment: 'linked', activity: 'idle' },
        { session: 'codex · Build', attachment: 'linked', activity: 'busy', detail: 'Build chat' },
      ],
    });
    expect((await get('/agent/who', null)).status).toBe(401);
    expect((await get('/agent/who', 'e'.repeat(64))).status).toBe(401);
    routes.setEnabled(false);
    expect((await get('/agent/who')).status).toBe(404);
    routes.setEnabled(true);
    const ok = await get('/agent/who');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { participants: unknown[] };
    expect(body.participants).toHaveLength(2);
    expect((body.participants[1] as { session: string }).session).toBe('codex · Build');
  });

  it('serves text rows without parsing-sensitive punctuation and sanitizes field breaks', async () => {
    const participants = [
      { session: 'claude · Job "Maya" [maya-update]', attachment: 'linked', activity: 'idle', detail: 'Title [x]' },
      { session: 'codex · tab\tnewline\r\n', attachment: 'linked', activity: 'busy', detail: 'detail\tline\nnext' },
    ];
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      who: () => participants,
    });

    const text = await get('/agent/who?format=text');
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await text.text()).toBe(
      'claude · Job "Maya" [maya-update]\tlinked\tidle\tTitle [x]\n' +
        'codex · tab newline  \tlinked\tbusy\tdetail line next\n',
    );
    expect(await (await get('/agent/who')).json()).toEqual({ participants });
  });

  it('is a GET-only route: a POST to /agent/who is 405', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      who: () => [],
    });
    const res = await fetch(`${base}/agent/who`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: 'x',
    });
    expect(res.status).toBe(405);
  });

  it('A8: a who call leaves only the pre-existing bus artifacts behind', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      who: () => [{ session: 'claude · Review', attachment: 'linked', activity: 'idle' }],
    });
    expect((await get('/agent/who')).status).toBe(200);
    expect(fs.readdirSync(paths.root).sort()).toEqual([
      'README.md',
      'endpoint.json',
      'endpoints',
      'forge.sh',
      'inbox',
      'outbox',
    ]);
  });
});

describe('GET /agent/status and /agent/view', () => {
  function install(deps: ConstructorParameters<typeof AgentRoutes>[0]): void {
    routes = new AgentRoutes(deps);
    routes.setEnabled(true);
    routes.onListening(base);
  }
  const get = (route: string, token: string | null = TOKEN): Promise<Response> =>
    fetch(`${base}${route}`, {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });

  it('returns 404 when the read dependencies are absent', async () => {
    expect((await get('/agent/status?from=claude')).status).toBe(404);
    expect((await get('/agent/view?from=claude')).status).toBe(404);
  });

  it('requires a token and GET', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      status: () => ({ ok: true, text: 'status' }),
    });
    expect((await get('/agent/status?from=claude', null)).status).toBe(401);
    const res = await fetch(`${base}/agent/status?from=claude`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: 'x',
    });
    expect(res.status).toBe(405);
  });

  it('validates sender shape and the configured sender', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      status: () => ({ ok: true, text: 'status' }),
      validateFrom: (from) =>
        from === 'claude' ? { ok: true } : { ok: false, error: 'unknown sender' },
    });
    const shape = await get('/agent/status?from=bad%21name');
    expect(shape.status).toBe(400);
    expect((await shape.json()).error).toBe(
      'from must be 1-40 chars: letters, digits, space . _ -',
    );
    const sender = await get('/agent/status?from=ghost');
    expect(sender.status).toBe(400);
    expect((await sender.json()).error).toBe('unknown sender');
  });

  it('returns dependency errors as JSON with their status', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      status: () => ({ ok: false, status: 404, error: 'x' }),
    });
    const res = await get('/agent/status?from=claude');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'x' });
  });

  it('serves plain text and passes the view count through, including when absent', async () => {
    const received: Array<string | undefined> = [];
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      status: () => ({ ok: true, text: 'hello' }),
      view: (_from, count) => {
        received.push(count);
        return { ok: true, text: 'answers' };
      },
    });
    const status = await get('/agent/status?from=claude');
    expect(status.status).toBe(200);
    expect(status.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await status.text()).toBe('hello\n');
    expect(await (await get('/agent/view?from=claude&count=2')).text()).toBe('answers\n');
    expect(await (await get('/agent/view?from=claude')).text()).toBe('answers\n');
    expect(received).toEqual(['2', undefined]);
  });
});

describe('GET /agent/chats', () => {
  function install(deps: ConstructorParameters<typeof AgentRoutes>[0]): void {
    routes = new AgentRoutes(deps);
    routes.setEnabled(true);
    routes.onListening(base);
  }
  const get = (route: string, token: string | null = TOKEN): Promise<Response> =>
    fetch(`${base}${route}`, {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });
  const report = {
    windowId: 'ignored-by-the-dep',
    workspace: 'N:/other',
    models: ['alpha'],
    chats: [{ id: 'peer-1', title: 'Worker', running: true, closed: false, awaitingApproval: false }],
  };

  it('is not registered when the window has no chats dependency', async () => {
    install({ paths: () => paths, inbox: stubInbox(), token: TOKEN });
    const res = await get('/agent/chats');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('no route for GET /agent/chats');
  });

  it('requires a token and GET only', async () => {
    install({ paths: () => paths, inbox: stubInbox(), token: TOKEN, chats: () => report });
    expect((await get('/agent/chats', null)).status).toBe(401);
    const post = await fetch(`${base}/agent/chats`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: 'x',
    });
    expect(post.status).toBe(405);
  });

  it('answers before the sender check, with this window\'s id handed to the dependency', async () => {
    const seen: string[] = [];
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      // A `from` this window would refuse outright: a peer has no session
      // identity, only the token, and it needs ids before it can name a chat.
      validateFrom: () => ({ ok: false, error: 'unknown sender' }),
      chats: (windowId) => {
        seen.push(windowId);
        return report;
      },
    });
    const res = await get('/agent/chats');
    expect(res.status).toBe(200);
    expect(seen).toEqual([routes.windowId]);
    expect(await res.json()).toEqual(report);
  });

  it('answers as JSON, and carries neither a tab number nor a transcript', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      chats: (windowId) => ({
        windowId,
        workspace: 'N:/work',
        models: ['alpha'],
        chats: [
          { id: 'peer-1', title: 'Worker', running: false, closed: true, awaitingApproval: false },
        ],
      }),
    });
    const res = await get('/agent/chats');
    expect(res.headers.get('content-type')).toMatch(/application\/json/u);
    const text = await res.text();
    expect(JSON.parse(text).chats[0].closed).toBe(true);
    // `#N` is window-local and a transcript is what `view` exists to fetch.
    expect(text).not.toMatch(/"position"/u);
    expect(text).not.toMatch(/transcript/iu);
  });
});

describe('GET /agent/peer-view', () => {
  function install(deps: ConstructorParameters<typeof AgentRoutes>[0]): void {
    routes = new AgentRoutes(deps);
    routes.setEnabled(true);
    routes.onListening(base);
  }
  const get = (route: string, token: string | null = TOKEN): Promise<Response> =>
    fetch(`${base}${route}`, {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });
  const report = {
    windowId: 'ignored-by-the-dep',
    workspace: 'N:/other',
    conversationId: 'peer-1',
    title: 'Worker',
    closed: false,
    streaming: true,
    clamped: false,
    exchanges: [{ prompt: 'Read the plan.', answer: 'I read the plan.' }],
  };

  it('is not registered when the window has no peerView dependency', async () => {
    install({ paths: () => paths, inbox: stubInbox(), token: TOKEN });
    const res = await get('/agent/peer-view?conversation_id=peer-1');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('no route for GET /agent/peer-view');
  });

  it('requires a token, and answers GET only', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      peerView: () => ({ ok: true, report }),
    });
    expect((await get('/agent/peer-view?conversation_id=peer-1', null)).status).toBe(401);
    const post = await fetch(`${base}/agent/peer-view?conversation_id=peer-1`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: 'x',
    });
    expect(post.status).toBe(405);
  });

  it('names the chat and the count it was asked for, before any sender check', async () => {
    const seen: unknown[] = [];
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      // A peer window has no session identity to attribute a read to, so this
      // route answers on the token alone — the same rule as `/agent/chats`.
      validateFrom: () => ({ ok: false, error: 'unknown sender' }),
      peerView: (conversationId, count, windowId) => {
        seen.push([conversationId, count, windowId]);
        return { ok: true, report };
      },
    });
    const res = await get('/agent/peer-view?conversation_id=peer-1&count=3');
    expect(res.status).toBe(200);
    expect(seen).toEqual([['peer-1', 3, routes.windowId]]);
    expect(await res.json()).toEqual(report);
  });

  it('refuses a read that does not name a chat, and clamps a count too big to send', async () => {
    const counts: number[] = [];
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      peerView: (_conversationId, count) => {
        counts.push(count);
        return { ok: true, report };
      },
    });
    expect((await get('/agent/peer-view')).status).toBe(400);
    expect((await get('/agent/peer-view?conversation_id=%20')).status).toBe(400);
    expect((await get('/agent/peer-view?conversation_id=peer-1&count=abc')).status).toBe(400);
    expect((await get('/agent/peer-view?conversation_id=peer-1&count=0')).status).toBe(400);
    // A count over the cap is clamped by the same parser the phone's `/view`
    // uses, so a caller that asks for 99 gets the most any window will send.
    expect((await get('/agent/peer-view?conversation_id=peer-1&count=99')).status).toBe(200);
    expect((await get('/agent/peer-view?conversation_id=peer-1&count=4')).status).toBe(200);
    expect(counts).toEqual([10, 4]);
  });

  it('forwards the window’s own 404 for a chat it does not hold', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      peerView: () => ({
        ok: false,
        status: 404 as const,
        error: 'Forge chat "peer-9" is no longer open',
      }),
    });
    const res = await get('/agent/peer-view?conversation_id=peer-9');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('no longer open');
  });
});

// A7 + A9: the client formats the route's JSON and takes no arguments. Bash-gated
// like the other forge.sh client tests (skipped where there is no usable bash+curl).
describe('forge.sh who against the routes (§11)', () => {
  let usable = false;
  beforeAll(async () => {
    const probe = path.join(os.tmpdir(), `forge-bash-who-${process.pid}`);
    fs.writeFileSync(probe, '');
    const bash = TEST_BASH;
    usable =
      !!bash &&
      (await new Promise<boolean>((resolve) =>
        execFile(
          bash,
          ['-c', 'test -f "$1" && command -v curl >/dev/null', '_', probe.replace(/\\/g, '/')],
          { timeout: 10_000, env: gitBashEnvironment() },
          (err) => resolve(!err),
        ),
      ));
    fs.rmSync(probe, { force: true });
  });

  function install(deps: ConstructorParameters<typeof AgentRoutes>[0]): void {
    routes = new AgentRoutes(deps);
    routes.setEnabled(true);
    routes.onListening(base);
  }

  it('prints one line per linked session from the route JSON', async (ctx) => {
    if (!usable) ctx.skip();
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      who: () => [
        {
          session: 'claude · Review',
          attachment: 'linked',
          activity: 'idle',
          detail: 'Review chat',
        },
        { session: 'codex · Build', attachment: 'linked', activity: 'busy', detail: 'Build chat' },
      ],
    });
    const res = await runClient(['who'], '');
    expect(res.code).toBe(0);
    expect(res.out).toContain('claude');
    expect(res.out).toContain('codex');
    expect(res.out).toContain('linked');
    expect(res.out).toContain('busy');
    expect(res.out).toContain('Build chat');
  }, 30_000);

  it('A9: who takes no arguments (an extra arg is a usage error)', async (ctx) => {
    if (!usable) ctx.skip();
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      who: () => [],
    });
    const res = await runClient(['who', 'extra'], '');
    expect(res.code).toBe(2);
  }, 30_000);
});
