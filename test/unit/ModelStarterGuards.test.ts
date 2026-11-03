/**
 * The request guards every starter route runs through
 * (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md, "Request rules").
 *
 * The starter has no token, so these are the whole of its HTTP defence: a Host
 * rule against DNS rebinding, a blanket refusal of any browser `Origin`, a JSON
 * content-type that forces a CORS preflight browsers cannot satisfy, a small
 * body cap, and a strict schema that rejects unknown keys. Each is tested
 * against the live listener, because the order of the guards is part of the
 * contract (a browser posting to an unknown route must be refused for being a
 * browser, not for the route).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { hostAllowed } from '../../src/backend/TailnetListener';
import {
  makeStarterConfig,
  startStarter,
  starterPost,
  starterRequest,
} from '../support/modelStarterHarness';

describe('hostAllowed (DNS-rebinding rule)', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.0.0.1:8798', true],
    ['100.64.0.10:8798', true],
    ['[::1]:8798', true],
    ['localhost', true],
    ['localhost:8798', true],
    ['LOCALHOST:8798', true],
    ['desktop-1', false],
    ['desktop-1:8798', false],
    ['evil.example.com', false],
    ['127.0.0.1.evil.example.com', false],
    ['', false],
    [undefined, false],
  ])('accepts %s? %s', (header, expected) => {
    expect(hostAllowed(header)).toBe(expected);
  });
});

describe('model starter request guards', () => {
  let running: { close: () => void } | undefined;
  afterEach(() => {
    running?.close();
    running = undefined;
  });

  it('refuses a name in the Host header, accepts an IP literal', async () => {
    const started = await startStarter(makeStarterConfig({ port: 0 }));
    running = started;
    const named = await starterRequest(started.port, {
      path: '/models',
      headers: { host: 'desktop-1.tailnet.ts' },
    });
    expect(named.status).toBe(403);
    expect(named.body?.error).toMatch(/IP address or localhost/);
    const byIp = await starterRequest(started.port, {
      path: '/models',
      headers: { host: `127.0.0.1:${started.port}` },
    });
    expect(byIp.status, 'an IP literal is what tailscale serve and curl send').toBe(200);
  });

  it('refuses any request carrying an Origin header', async () => {
    const started = await startStarter(makeStarterConfig({ port: 0 }));
    running = started;
    for (const path of ['/models', '/ensure']) {
      const response = await starterRequest(started.port, {
        method: path === '/models' ? 'GET' : 'POST',
        path,
        headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
        body: path === '/ensure' ? '{"client":"laptop","model":"gemma-iq3s"}' : undefined,
      });
      expect(response.status, path).toBe(403);
    }
  });

  it('refuses a POST that is not application/json', async () => {
    const started = await startStarter(makeStarterConfig({ port: 0 }));
    running = started;
    const form = await starterRequest(started.port, {
      method: 'POST',
      path: '/ensure',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'client=laptop&model=gemma-iq3s',
    });
    expect(form.status).toBe(415);
    const missing = await starterRequest(started.port, {
      method: 'POST',
      path: '/ensure',
      body: '{"client":"laptop","model":"gemma-iq3s"}',
    });
    expect(missing.status).toBe(415);
    // The charset variant browsers add must still be accepted.
    const withCharset = await starterPost(
      started.port,
      '/ensure',
      { client: 'laptop', model: 'strata-offacl' },
      { 'content-type': 'application/json; charset=utf-8' },
    );
    expect(withCharset.status, 'not a 415: the content type is JSON').not.toBe(415);
  });

  it('refuses a body over 4 KB with 413', async () => {
    const started = await startStarter(makeStarterConfig({ port: 0 }));
    running = started;
    const big = await starterPost(started.port, '/ensure', {
      client: 'laptop',
      model: 'gemma-iq3s',
      pad: 'x'.repeat(5000),
    });
    expect(big.status).toBe(413);
    expect(big.body?.error).toMatch(/at most 4096/);
    const small = await starterPost(started.port, '/release', { client: 'laptop' });
    expect(small.status).toBe(200);
    // A chunked POST has no content-length to check up front, so `readJson`'s
    // own cap closes the socket rather than answering: the client sees a reset,
    // not a 413. Every real client (curl, fetch, undici with a string body)
    // sends content-length and gets the answer.
    await expect(
      starterRequest(started.port, {
        method: 'POST',
        path: '/release',
        headers: { 'content-type': 'application/json' },
        body: `{"client":"${'l'.repeat(5000)}"}`,
        chunked: true,
      }),
    ).rejects.toThrow(/socket hang up|ECONNRESET/);
    // The listener survived its own reset.
    expect((await starterPost(started.port, '/release', { client: 'laptop' })).status).toBe(200);
  });

  it('refuses unknown keys and malformed bodies with 400', async () => {
    const started = await startStarter(makeStarterConfig({ port: 0 }));
    running = started;
    const extra = await starterPost(started.port, '/ensure', {
      client: 'laptop',
      model: 'gemma-iq3s',
      stop_command: ['whoami'],
    });
    expect(extra.status).toBe(400);
    expect(extra.body?.error).toMatch(/stop_command/);
    const notAnObject = await starterPost(started.port, '/release', '["laptop"]', {});
    expect(notAnObject.status).toBe(400);
    const unparsable = await starterRequest(started.port, {
      method: 'POST',
      path: '/release',
      headers: { 'content-type': 'application/json' },
      body: '{client',
    });
    expect(unparsable.status).toBe(400);
    const blankModel = await starterPost(started.port, '/ensure', {
      client: 'laptop',
      model: '   ',
    });
    expect(blankModel.status).toBe(400);
  });

  it('404s a model the desktop config does not name, before loading anything', async () => {
    const started = await startStarter(makeStarterConfig({ port: 0 }));
    running = started;
    const response = await starterPost(started.port, '/ensure', {
      client: 'laptop',
      model: 'whatever-the-laptop-invented',
    });
    expect(response.status).toBe(404);
    expect(started.pool.loadedModelNames()).toEqual([]);
    expect(started.pool.releases).toEqual([]);
  });
});
