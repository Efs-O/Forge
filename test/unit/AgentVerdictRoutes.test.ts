import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { busPaths, type BusPaths } from '../../src/agentBus/agentBus';
import { appendEvent, type ExchangeLogPaths } from '../../src/agentMesh/exchangeLog';
import { verdictArtifactPath, type WaitingVerdict } from '../../src/agentMesh/verdictArtifact';
import { AgentRoutes } from '../../src/backend/agentRoutes';
import { listenLoopback } from '../support/listenLoopback';

const TOKEN = 'a'.repeat(64);

describe('authenticated full-verdict routes', () => {
  let home: string;
  let paths: BusPaths;
  let exchangePaths: ExchangeLogPaths;
  let routes: AgentRoutes;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verdict-route-'));
    paths = busPaths(home);
    exchangePaths = {
      log: path.join(paths.root, 'exchanges.jsonl'),
      lock: path.join(paths.root, 'exchanges.lock'),
    };
    fs.mkdirSync(path.join(paths.root, 'verdicts'), { recursive: true });
    await appendEvent(exchangePaths, {
      eventId: 'start-x1', ts: 1, exchangeId: 'x1', workspace: 'work',
      from: 'codex', to: 'forge', type: 'state', state: 'created',
    });
    await appendEvent(exchangePaths, {
      eventId: 'accepted-x1', ts: 2, exchangeId: 'x1', workspace: 'work',
      from: 'forge', to: 'codex', type: 'state', state: 'accepted',
    });
    await appendEvent(exchangePaths, {
      eventId: 'verdict-x1', ts: 3, exchangeId: 'x1', workspace: 'work',
      from: 'forge', to: 'codex', type: 'verdict', state: 'completed',
      detail: 'read the artifact',
    });
    fs.writeFileSync(verdictArtifactPath(paths.root, 'x1'), 'full verdict ' + 'x'.repeat(900));
    routes = new AgentRoutes({
      paths: () => paths,
      token: TOKEN,
      inbox: { accept: () => undefined, cancel: () => 0 },
      validateFrom: (from) =>
        from === 'codex' || from === 'claude'
          ? { ok: true }
          : { ok: false, error: 'unknown sender' },
    });
    server = http.createServer((req, res) => void routes.handle(req, res));
    const port = await listenLoopback(server);
    base = `http://127.0.0.1:${port}`;
    routes.setEnabled(true);
    routes.onListening(base);
  });

  afterEach(async () => {
    routes.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  });

  const headers = (token = TOKEN) => ({ Authorization: `Bearer ${token}` });
  const artifact = () => verdictArtifactPath(paths.root, 'x1');

  it('repeats a lost read safely; only an explicit acknowledgment deletes the copy', async () => {
    const url = `${base}/agent/read-verdict?from=codex&id=x1`;
    const first = await fetch(url, { headers: headers() });
    expect(first.status).toBe(200);
    // Simulate losing the first response body, then repeating the read.
    const second = await fetch(url, { headers: headers() });
    expect(await second.text()).toBe('full verdict ' + 'x'.repeat(900));
    expect(fs.existsSync(artifact())).toBe(true);
    const ack = await fetch(`${base}/agent/ack-verdict`, {
      method: 'POST', headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'from=codex&id=x1',
    });
    expect(ack.status).toBe(200);
    expect(fs.existsSync(artifact())).toBe(false);
    expect((await fetch(url, { headers: headers() })).status).toBe(404);
  });

  it('rejects a stale token, another sender, and a cross-exchange read before deletion', async () => {
    expect((await fetch(`${base}/agent/read-verdict?from=codex&id=x1`, {
      headers: headers('wrong'),
    })).status).toBe(401);
    expect((await fetch(`${base}/agent/read-verdict?from=claude&id=x1`, {
      headers: headers(),
    })).status).toBe(404);
    expect((await fetch(`${base}/agent/ack-verdict`, {
      method: 'POST', headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'from=claude&id=x1',
    })).status).toBe(404);
    expect(fs.existsSync(artifact())).toBe(true);
  });

  // Bridge review (V1_FINISH_PLAN lane 2, phase 2.0): a session-bound exchange
  // must not be readable by a caller that merely names its sender kind. Every
  // `forge.sh read-verdict`/`ack-verdict` sends the kind-specific identity
  // (`set_sender_identity`), so this only ever loosens nothing: it closes the
  // window where any holder of the shared token could read another Claude
  // session's verdict by leaving the sessionId out.
  it('requires the session id an exchange recorded, and still admits a kind-only read when none was recorded', async () => {
    const session = '8e395649-705e-47f9-b499-03a36e908f51';
    const other = '8e395649-705e-47f9-b499-03a36e908f99';
    for (const event of [
      {
        eventId: 'start-x2', ts: 4, exchangeId: 'x2', workspace: 'work',
        from: 'claude', senderSessionId: session, to: 'codex', type: 'relay', state: 'created',
      },
      {
        eventId: 'accepted-x2', ts: 5, exchangeId: 'x2', workspace: 'work',
        from: 'claude', senderSessionId: session, to: 'codex', type: 'relay', state: 'accepted',
      },
      {
        eventId: 'verdict-x2', ts: 6, exchangeId: 'x2', workspace: 'work',
        from: 'claude', to: 'codex', type: 'verdict', state: 'completed',
        detail: 'answer retained as verdict',
      },
    ] as const) {
      await appendEvent(exchangePaths, event);
    }
    const x2 = verdictArtifactPath(paths.root, 'x2');
    fs.writeFileSync(x2, 'session-bound verdict');
    const read = (query: string) =>
      fetch(`${base}/agent/read-verdict?${query}`, { headers: headers() });
    // A caller that leaves the identity out used to pass for any Claude session.
    expect((await read('from=claude&id=x2')).status).toBe(404);
    expect(fs.existsSync(x2)).toBe(true);
    // A wrong session id keeps failing the same way it always did.
    expect((await read(`from=claude&id=x2&kind=claude&sessionId=${other}`)).status).toBe(404);
    expect(fs.existsSync(x2)).toBe(true);
    // The session the exchange recorded can read it as often as it likes.
    const hit = await read(`from=claude&id=x2&kind=claude&sessionId=${session}`);
    expect(hit.status).toBe(200);
    expect(await hit.text()).toBe('session-bound verdict');
    // ...and acknowledge it with the same identity.
    const ack = await fetch(`${base}/agent/ack-verdict`, {
      method: 'POST', headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `from=claude&id=x2&kind=claude&sessionId=${other}`,
    });
    expect(ack.status).toBe(404);
    expect(fs.existsSync(x2)).toBe(true);
    expect((await fetch(`${base}/agent/ack-verdict`, {
      method: 'POST', headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `from=claude&id=x2&kind=claude&sessionId=${session}`,
    })).status).toBe(200);
    expect(fs.existsSync(x2)).toBe(false);
    // An exchange whose events recorded no session id is still read by kind
    // alone, as before: `x1` above proves that path still works. What it will
    // not do is admit a caller that brings an id the exchange never saw — the
    // identity has to be the same on both sides, or absent on both.
    expect((await read('from=codex&id=x1')).status).toBe(200);
    expect(
      (await read(`from=codex&id=x1&kind=codex&sessionId=${session}`)).status,
    ).toBe(404);
  });
});

/** The two verdict routes answer in two shapes, so a waiting answer rides each
 *  one differently (`src/backend/agentWaitingVerdicts.ts`): `read-verdict` is
 *  the verdict's own markdown, so its notices are trailer lines; `ack-verdict`
 *  answers JSON, so its notices are the `waiting_verdicts` field and the body
 *  stays parseable for every client of the control server. */
describe('a waiting answer beside a verdict read or ack', () => {
  const SESSION = '8e395649-705e-47f9-b499-03a36e908f51';
  const OTHER = '8e395649-705e-47f9-b499-03a36e908f99';
  const WAITING: WaitingVerdict = {
    exchangeId: 'x2',
    senderSessionId: SESSION,
    from: 'claude',
    conversationId: 'c2',
    chatLabel: 'Nightly [audit] "quoted" chat',
    verdictTs: 6,
  };

  let home: string;
  let paths: BusPaths;
  let routes: AgentRoutes;
  let server: http.Server;
  let base: string;

  /** `waitingFor` is what the window would answer for the caller's session. */
  async function setup(waitingFor: (senderSessionId: string) => WaitingVerdict[]): Promise<void> {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verdict-waiting-'));
    paths = busPaths(home);
    const exchangePaths: ExchangeLogPaths = {
      log: path.join(paths.root, 'exchanges.jsonl'),
      lock: path.join(paths.root, 'exchanges.lock'),
    };
    fs.mkdirSync(path.join(paths.root, 'verdicts'), { recursive: true });
    for (const event of [
      {
        eventId: 'start-x1', ts: 1, exchangeId: 'x1', workspace: 'work',
        from: 'claude', senderSessionId: SESSION, to: 'forge', type: 'relay', state: 'created',
      },
      {
        eventId: 'accepted-x1', ts: 2, exchangeId: 'x1', workspace: 'work',
        from: 'claude', senderSessionId: SESSION, to: 'forge', type: 'relay', state: 'accepted',
      },
      {
        eventId: 'verdict-x1', ts: 3, exchangeId: 'x1', workspace: 'work',
        from: 'claude', to: 'claude', type: 'verdict', state: 'completed',
        detail: 'the session was not live; retained for read-verdict',
      },
    ] as const) {
      await appendEvent(exchangePaths, event);
    }
    fs.writeFileSync(verdictArtifactPath(paths.root, 'x1'), 'the verdict text');
    routes = new AgentRoutes({
      paths: () => paths,
      token: TOKEN,
      inbox: { accept: () => undefined, cancel: () => 0 },
      waitingVerdicts: waitingFor,
    });
    server = http.createServer((req, res) => void routes.handle(req, res));
    const port = await listenLoopback(server);
    base = `http://127.0.0.1:${port}`;
    routes.setEnabled(true);
    routes.onListening(base);
  }

  afterEach(() => {
    routes.dispose();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const identity = `from=claude&kind=claude&sessionId=${SESSION}`;
  const ackUrl = (): string => `${base}/agent/ack-verdict`;
  const ackBody = (id: string, sessionId = SESSION): string =>
    `from=claude&kind=claude&id=${id}&sessionId=${sessionId}`;
  const postAck = async (
    body: string,
  ): Promise<{ status: number; text: string; json: Record<string, unknown> }> => {
    const response = await fetch(ackUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const text = await response.text();
    // Parsing here is the assertion: a body that is not JSON throws, and the
    // test fails rather than quietly accepting a text-after-JSON answer.
    return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
  };

  it('an ack response is valid JSON whose field names what is still waiting', async () => {
    await setup(() => [WAITING]);
    const ack = await postAck(ackBody('x1'));
    expect(ack.status).toBe(200);
    expect(ack.json).toEqual({
      acknowledged: true,
      waiting_verdicts: [{ exchangeId: 'x2', chat: 'Nightly [audit] "quoted" chat' }],
    });
  });

  it('an ack with nothing waiting answers exactly {acknowledged: true}', async () => {
    await setup(() => []);
    const ack = await postAck(ackBody('x1'));
    expect(ack.status).toBe(200);
    expect(ack.text).toBe('{"acknowledged":true}');
    expect(ack.json).toEqual({ acknowledged: true });
    expect(ack.json).not.toHaveProperty('waiting_verdicts');
  });

  it('an ack by another session answers exactly what it answered before', async () => {
    await setup((senderSessionId) => (senderSessionId === SESSION ? [WAITING] : []));
    const other = await postAck(ackBody('x1', OTHER));
    // Another session cannot ack this exchange, so it gets the old refusal —
    // and never this session's waiting list.
    expect(other.status).toBe(404);
    expect(other.json).toEqual({ error: 'verdict unavailable for this sender and exchange' });
  });

  it("a read is still the verdict's own markdown, with one trailer line per answer", async () => {
    await setup(() => [WAITING]);
    const read = await fetch(`${base}/agent/read-verdict?${identity}&id=x1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await read.text()).toBe(
      'the verdict text\nWAITING_VERDICT\tx2\tNightly [audit] "quoted" chat',
    );
  });

  it('a read with nothing waiting is the verdict and nothing else', async () => {
    await setup(() => []);
    const read = await fetch(`${base}/agent/read-verdict?${identity}&id=x1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(await read.text()).toBe('the verdict text');
  });
});
