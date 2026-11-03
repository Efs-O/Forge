import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { busPaths, type BusPaths } from '../../src/agentBus/agentBus';
import { appendEvent, type ExchangeLogPaths } from '../../src/agentMesh/exchangeLog';
import { verdictArtifactPath } from '../../src/agentMesh/verdictArtifact';
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
