import * as http from 'http';
import type { AddressInfo } from 'net';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { busPaths } from '../../src/agentBus/agentBus';
import { AgentRoutes } from '../../src/backend/agentRoutes';
import { TEST_BASH } from '../support/bash';

const id = '8e395649-705e-47f9-b499-03a36e908f50';
const token = 'a'.repeat(64);
let server: http.Server | undefined;
let dir: string | undefined;
let routes: AgentRoutes | undefined;

afterEach(async () => {
  routes?.dispose();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  server = undefined;
  dir = undefined;
});

describe('agent bus remote session routes', () => {
  it('requires the bus token and returns a scoped question id', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-route-'));
    const dispatch = vi.fn(async (_from: string, _id: string, action: 'ask' | 'notify') =>
      action === 'ask' ? { kind: 'asked' as const, questionId: id } : { kind: 'notified' as const },
    );
    routes = new AgentRoutes({
      paths: () => busPaths(dir), token,
      inbox: { accept: () => undefined, cancel: () => 0 },
      validateFrom: async (from) => from === 'codex' ? { ok: true } : { ok: false, error: 'unknown sender' },
      remoteSession: dispatch,
    });
    server = http.createServer((req, res) => void routes!.handle(req, res));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    routes.setEnabled(true);
    routes.onListening(base);
    const url = `${base}/agent/remote-ask?from=codex&exchange_id=${id}`;
    const wrong = await fetch(url, { method: 'POST', body: 'Which file?' });
    expect(wrong.status).toBe(401);
    const good = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'Which file?' });
    expect(good.status).toBe(200);
    expect((await good.text()).trim()).toBe(id);
    expect(dispatch).toHaveBeenCalledWith('codex', id, 'ask', 'Which file?');
    if (TEST_BASH) {
      const busRoot = busPaths(dir).root;
      await fs.copyFile(path.join(process.cwd(), 'src', 'agentBus', 'forge.sh'), path.join(busRoot, 'forge.sh'));
      await fs.mkdir(path.join(busRoot, 'remote-answers'));
      await fs.writeFile(path.join(busRoot, 'remote-answers', `${id}.md`), 'src/main.ts');
      const question = path.join(dir, 'question.txt');
      await fs.writeFile(question, 'Which file?');
      const output = await new Promise<string>((resolve, reject) =>
        execFile(TEST_BASH, [path.join(busRoot, 'forge.sh'), 'remote-ask', 'codex', id, question],
          { encoding: 'utf8', timeout: 10_000, windowsHide: true },
          (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)),
      );
      expect(output).toBe('src/main.ts');
    }
  }, 15_000);
});
