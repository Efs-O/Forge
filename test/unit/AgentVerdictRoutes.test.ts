import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { busPaths, type BusPaths } from '../../src/agentBus/agentBus';
import { appendEvent, type ExchangeLogPaths } from '../../src/agentMesh/exchangeLog';
import { verdictArtifactPath } from '../../src/agentMesh/verdictArtifact';
import { AgentRoutes } from '../../src/backend/agentRoutes';

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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
});
