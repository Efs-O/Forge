import { execFile } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  busPaths,
  clearExchange,
  waitForReply,
  writeQuestion,
  type BusPaths,
} from '../../src/agentBus/agentBus';
import { AgentRoutes } from '../../src/backend/agentRoutes';
import { TEST_BASH } from '../support/bash';

const TOKEN = 'f'.repeat(64);
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

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-agent-routes-'));
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
  server = http.createServer((req, res) => void routes.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  routes.setEnabled(true);
  routes.onListening(base);
});

afterEach(async () => {
  routes.dispose();
  await new Promise((r) => server.close(r));
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
    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.endpoint).mode & 0o777).toBe(0o600);
    }
    routes.dispose();
    expect(fs.existsSync(paths.endpoint)).toBe(false);
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

  it('only lets a focused window claim the shared endpoint', () => {
    routes.dispose();
    focused = false;
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      isFocused: () => focused,
    });
    routes.setEnabled(true);
    routes.onListening(base);
    expect(fs.existsSync(paths.endpoint)).toBe(false);

    focused = true;
    routes.claim();
    expect(JSON.parse(fs.readFileSync(paths.endpoint, 'utf8'))).toMatchObject({
      url: base,
      token: TOKEN,
    });

    focused = false;
    fs.writeFileSync(paths.endpoint, JSON.stringify({ url: 'other', token: 'other' }));
    routes.claim();
    expect(JSON.parse(fs.readFileSync(paths.endpoint, 'utf8'))).toMatchObject({
      url: 'other',
      token: 'other',
    });
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

  it('keeps an explicit chat reply in Forge without changing ordinary Claude replies', async () => {
    const codex = await post('/agent/message?from=codex&reply_in_chat=true', 'question');
    expect(codex.status).toBe(202);
    expect(accepted[0]).toContain('Answer in this Forge chat');
    expect(acceptedOptions[0]).toEqual({ replyInChat: true });

    const claude = await post('/agent/message?from=claude', 'question');
    expect(claude.status).toBe(202);
    expect(accepted[1]).toContain('call `ask_live_session` with `target: "claude"`');
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

  it('validates reply_in_chat as a boolean', async () => {
    const response = await post('/agent/message?from=codex&reply_in_chat=maybe', 'nope');
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
      'forge.sh',
      'inbox',
      'outbox',
    ]);
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
    expect(fs.readdirSync(paths.outbox)).toEqual([]);
  });

  it('refuses other methods and paths', async () => {
    const get = await fetch(`${base}/agent/message`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(405);
    expect((await post('/agent/other', 'x')).status).toBe(404);
  });
});

/** Run the shipped client the way another agent would. Async: the routes
 *  answer from this same process, so a blocking spawn would deadlock. */
function runClient(
  args: string[],
  input: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      TEST_BASH ?? 'bash',
      [paths.script.replace(/\\/g, '/'), ...args],
      { timeout: 20_000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === 'number' ? code : 1, out: stdout + stderr });
      },
    );
    child.stdin?.end(input);
  });
}

describe('forge.sh against the routes', () => {
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
          { timeout: 10_000 },
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
    expect(said).toMatchObject({ code: 0 });
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

  it('send-file uses the authenticated CLI route without accepting a Forge inbox turn', async (ctx) => {
    if (!usable) ctx.skip();
    const validateFrom = vi.fn(async (from: string) =>
      from === 'codex' ? { ok: true as const } : { ok: false as const, error: 'unknown sender' },
    );
    const sendFile = vi.fn(async () => ({ kind: 'sent' as const }));
    installClientRoutes({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      validateFrom,
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
    );

    expect(sent.code).toBe(0);
    expect(sent.out).toContain('"sent":true');
    expect(validateFrom).toHaveBeenCalledWith('codex');
    expect(sendFile).toHaveBeenCalledWith(
      'codex',
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
      validateFrom: (from) =>
        from === 'codex' ? { ok: true } : { ok: false, error: 'unknown sender' },
      sendFile,
    });
    const request = (fields: Record<string, unknown>, query = '') =>
      post(`/agent/send-file${query}`, JSON.stringify(fields), { type: 'application/json' });

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
    const said = await runClient(['say', '--model', 'alpha', '--new', 'claude'], 'new chat\n');
    expect(said.code).toBe(0);
    expect(acceptedOptions[0]).toEqual({ model: 'alpha', newChat: true });
  }, 30_000);

  it('say parses --reply-in-chat without changing the default', async (ctx) => {
    if (!usable) ctx.skip();
    const said = await runClient(['say', 'codex', '--reply-in-chat'], 'question\n');
    expect(said.code).toBe(0);
    expect(accepted[0]).toContain('Answer in this Forge chat');
    expect(acceptedOptions[0]).toEqual({ replyInChat: true });
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

  it('join sends the interactive Claude pid or Codex thread; send relays with a `to` (§10)', async (ctx) => {
    if (!usable) ctx.skip();
    const joins: [string, number, string][] = [];
    const relays: [string, string, string][] = [];
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: { accept: () => ({ position: 1, id: 'm1' }), cancel: () => 0 },
      token: TOKEN,
      join: (alias, pid, thread) => (
        joins.push([alias, pid, thread]),
        { ok: true, reply: 'joined' }
      ),
      relay: async (from, to, text) => (
        relays.push([from, to, text]),
        {
          ok: true,
          exchangeId: 'x1',
          deliveredTo: 'claude = session 7b39fb6e (joined, workspace n:\\vs code apps\\Forge)',
        }
      ),
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const noPid = await runClient(['join', 'claude'], '', { CLAUDE_PID: '' });
    expect(noPid.code).toBe(2);
    const joined = await runClient(['join', 'claude'], '', { CLAUDE_PID: '4242' });
    expect(joined.out).toContain('"joined":true');
    const joinedCodex = await runClient(['join', 'codex'], '', { CODEX_THREAD_ID: 'thread-7' });
    expect(joinedCodex.out).toContain('"joined":true');
    expect(joins).toEqual([
      ['claude', 4242, ''],
      ['codex', 0, 'thread-7'],
    ]);
    const sent = await runClient(['send', 'claude', 'codex'], 'plan ready\n');
    expect(JSON.parse(sent.out.trim())).toMatchObject({
      relayed: true,
      exchangeId: 'x1',
      delivered_to: 'claude = session 7b39fb6e (joined, workspace n:\\vs code apps\\Forge)',
      message:
        'Sent as exchange x1. The verdict does NOT start a turn in your chat by itself. Use ' +
        '`ask_live_session` with `notify_on_answer`, or `wait` and then `read-verdict`.',
    });
    expect(relays).toEqual([['claude', 'codex', 'plan ready\n']]);
  }, 30_000);

  it('steer to forge queues at the front and interrupts the running turn (§6)', async (ctx) => {
    if (!usable) ctx.skip();
    const calls: string[] = [];
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: {
        accept: (_prompt, _from, front) => (
          calls.push(`accept front=${String(front)}`),
          { position: 1, id: 'm1' }
        ),
        cancel: () => 0,
      },
      token: TOKEN,
      interruptForge: async () => {
        calls.push('interrupt');
        return { steered: true, conversationId: 'sender-chat', title: 'Codex: task' };
      },
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const steered = await runClient(['steer', 'claude', 'forge'], 'use ask_live_session');
    expect(JSON.parse(steered.out.trim())).toMatchObject({
      queued: expect.any(Number),
      id: expect.any(String),
      steered: true,
      conversationId: 'sender-chat',
      title: 'Codex: task',
    });
    expect(calls).toEqual(['accept front=true', 'interrupt']);
    const said = await runClient(['say', 'claude'], 'plain');
    expect(said.out).toContain('"queued"');
    expect(calls.slice(2)).toEqual(['accept front=false']);
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

    const said = await runClient(['say', 'codex', '--to', 'sender-chat'], 'direct follow-up\n');
    const sent = await runClient(['send', 'codex', 'forge', '--to-running'], 'interrupt context\n');

    expect(said.code).toBe(0);
    expect(said.out).toContain('"conversationId":"sender-chat"');
    expect(sent.code).toBe(0);
    expect(sent.out).toContain('"conversationId":"running-chat"');
    expect(delivered).toEqual([
      expect.objectContaining({ targetConversationId: 'sender-chat' }),
      expect.objectContaining({ toRunning: true, targetConversationId: 'running-chat' }),
    ]);
  }, 30_000);

  it('refuses a queued message from the agent Forge is blocked on, for any sender', async (ctx) => {
    if (!usable) ctx.skip();
    const calls: string[] = [];
    const awaited: Record<string, string> = { claude: 'fg1-aaaa', codex: 'fg2-bbbb' };
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: {
        accept: (_prompt, from, front) => (
          calls.push(`${String(from)} front=${String(front)}`),
          { position: 1, id: 'm1' }
        ),
        cancel: () => 0,
      },
      token: TOKEN,
      interruptForge: async () => {
        calls.push('interrupt');
        return { steered: true, conversationId: 'sender-chat', title: 'Codex: task' };
      },
      awaitingAnswerFrom: (from) => awaited[from],
    });
    routes.setEnabled(true);
    routes.onListening(base);
    for (const sender of ['claude', 'codex']) {
      const said = await runClient(['say', sender], 'redo 70K');
      expect(said.code).not.toBe(0);
      expect(said.out).toContain(`forge.sh reply ${awaited[sender]}`);
    }
    expect(calls).toEqual([]);
    // A steer is the explicit stop and still gets through; others still queue.
    expect((await runClient(['steer', 'codex', 'forge'], 'stop')).out).toContain('"steered":true');
    expect((await runClient(['say', 'copilot'], 'plain')).out).toContain('"queued"');
    expect(calls).toEqual(['codex front=true', 'interrupt', 'copilot front=false']);
  }, 30_000);

  it('refuses a bad id or name before sending anything', async (ctx) => {
    if (!usable) ctx.skip();
    expect((await runClient(['reply', '../x'], 'a')).code).toBe(2);
    expect((await runClient(['say', 'a b'], 'a')).code).toBe(2);
    expect((await runClient(['cancel', 'x', '../m1'], '')).code).toBe(2);
    expect((await runClient(['cancel', 'x'], '')).code).toBe(2);
    expect(accepted).toEqual([]);
  }, 30_000);

  it('wait: refuses bad names, timeouts, arity and env overrides before any request', async (ctx) => {
    if (!usable) ctx.skip();
    expect((await runClient(['wait', 'a b'], '')).code).toBe(2);
    expect((await runClient(['wait', 'x', 'abc'], '')).code).toBe(2);
    expect((await runClient(['wait', 'x', '0'], '')).code).toBe(2);
    expect((await runClient(['wait', 'x', '100001'], '')).code).toBe(2);
    expect((await runClient(['wait', 'x', '1', 'extra'], '')).code).toBe(2);
    expect((await runClient(['wait', 'x'], '', { FORGE_WAIT_POLL_SECONDS: 'nope' })).code).toBe(2);
    expect((await runClient(['wait', 'x'], '', { FORGE_WAIT_POLL_SECONDS: '0' })).code).toBe(2);
    expect((await runClient(['wait', 'x'], '', { FORGE_WAIT_TIMEOUT_SECONDS: 'nope' })).code).toBe(
      2,
    );
    expect((await runClient(['wait', 'x'], '', { FORGE_WAIT_TIMEOUT_SECONDS: '0' })).code).toBe(2);
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
    const res = await runClient(['wait', 'x'], '', { FORGE_WAIT_POLL_SECONDS: '1' });
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
    const res = await runClient(['wait', 'x'], '', { FORGE_WAIT_POLL_SECONDS: '1' });
    expect(res.code).toBe(0);
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
    const res = await runClient(['wait', 'x'], '', { FORGE_WAIT_POLL_SECONDS: '1' });
    expect(res.code).toBe(0);
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
    const res = await runClient(['wait', 'x'], '', { FORGE_WAIT_POLL_SECONDS: '1' });
    expect(res.code).toBe(0);
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
    const res = await runClient(['wait', 'x', '1'], '', {
      FORGE_WAIT_POLL_SECONDS: '1',
      FORGE_WAIT_TIMEOUT_SECONDS: '1',
    });
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

describe('typed lifecycle command dispatch (§8, P3)', () => {
  function install(deps: ConstructorParameters<typeof AgentRoutes>[0]): void {
    routes = new AgentRoutes(deps);
    routes.setEnabled(true);
    routes.onListening(base);
  }

  it('dispatches a `to: forge` mesh command, not the inbox', async () => {
    let got: string | undefined;
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      validateFrom: () => ({ ok: true }),
      handleCommand: async (text) => {
        got = text;
        return { ok: true, reply: 'codex parked' };
      },
    });
    const { status, body } = await post('/agent/message?from=codex', 'standby codex');
    expect(status).toBe(200);
    expect(body).toEqual({ command: 'standby', reply: 'codex parked' });
    expect(got).toBe('standby codex');
    expect(accepted).toEqual([]); // not queued as a prompt
  });

  it('treats ordinary `to: forge` text as a prompt, not a command', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      validateFrom: () => ({ ok: true }),
      handleCommand: async () => ({ ok: true, reply: 'should not be called' }),
    });
    const { status } = await post('/agent/message?from=codex', 'please review the plan');
    expect(status).toBe(202);
    expect(accepted).toHaveLength(1);
  });

  it('a command that fails to dispatch is a 400, not a queued prompt', async () => {
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      validateFrom: () => ({ ok: true }),
      handleCommand: async () => ({ ok: false, error: 'no session to park' }),
    });
    const { status, body } = await post('/agent/message?from=codex', 'standby ghost');
    expect(status).toBe(400);
    expect(body.error).toContain('no session to park');
    expect(accepted).toEqual([]);
  });
});

describe('GET /agent/who (§11)', () => {
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
        { alias: 'forge', attachment: 'hub', activity: 'idle' },
        { alias: 'codex', attachment: 'owned', activity: 'parked', detail: 'warm' },
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
    expect((body.participants[1] as { alias: string }).alias).toBe('codex');
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
      who: () => [{ alias: 'forge', attachment: 'hub', activity: 'idle' }],
    });
    expect((await get('/agent/who')).status).toBe(200);
    expect(fs.readdirSync(paths.root).sort()).toEqual([
      'README.md',
      'endpoint.json',
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
          { timeout: 10_000 },
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

  it("A7: prints one line per participant from the route's JSON", async (ctx) => {
    if (!usable) ctx.skip();
    install({
      paths: () => paths,
      inbox: stubInbox(),
      token: TOKEN,
      who: () => [
        { alias: 'forge', attachment: 'hub', activity: 'busy', detail: 'inbox 1' },
        { alias: 'claude', attachment: 'joined', activity: 'unknown', detail: 'pid 33396' },
        { alias: 'codex', attachment: 'owned', activity: 'parked', detail: 'warm' },
      ],
    });
    const res = await runClient(['who'], '');
    expect(res.code).toBe(0);
    expect(res.out).toContain('forge');
    expect(res.out).toContain('hub');
    expect(res.out).toContain('claude');
    expect(res.out).toContain('joined');
    expect(res.out).toContain('codex');
    expect(res.out).toContain('parked');
    expect(res.out).toContain('33396');
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
