 /**
 * The CI-enforced ledger row of docs/plans/LAPTOP_MODEL_STARTER_PLAN.md, grown
 * to cover the pass-through of docs/plans/V1_FINISH_PLAN.md lane 3 phase 3.1.
 *
 * The starter has no key and no token. It is safe only because it can do
 * nothing except start, load and unload models that the DESKTOP's own config
 * already names, and because the traffic it forwards is model traffic to models
 * it is already willing to serve. Every widening of that surface — a fifth
 * route, a pass-through that accepts a path shape it should not, a target that
 * is a cloud model or an Ollama daemon or one of Forge's own service ports, a
 * bind beyond loopback, chat or agent code pulled in so a route can answer a
 * prompt — would silently turn a token-less listener into a way for any tailnet
 * peer to spend the owner's GPU and API budget. These assertions make widening a
 * CI failure instead of something a reviewer has to remember.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  STARTER_PASSTHROUGH_SHAPE,
  STARTER_ROUTES,
} from '../../src/backend/ModelStarterServer';
import { starterPassThroughRoute } from '../../src/backend/ModelStarterPassThrough';
import {
  makeStarterConfig,
  startPassThroughStarter,
  startStarter,
  starterRequest,
} from '../support/modelStarterHarness';

const srcRoot = path.resolve(__dirname, '..', '..', 'src');
const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(srcRoot, ...parts), 'utf8');

/** Runtime specifiers of a module: what it actually pulls in, comments aside. */
function importedSpecifiers(source: string): string[] {
  return [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]!);
}

const STARTER_MODULES = [
  ['backend', 'ModelStarterServer.ts'],
  ['backend', 'ModelStarterLeases.ts'],
  ['backend', 'ModelStarterEnsure.ts'],
  // The pass-through is starter code, so it is guarded the same way: a
  // "convenience" that pulled in `src/llm/` would put a token-less way to spend
  // the owner's budget behind one of these imports.
  ['backend', 'ModelStarterPassThrough.ts'],
] as const;

describe('model starter surface (CI-enforced ledger row)', () => {
  let running: { close: () => void } | undefined;
  let passThrough: { close: () => Promise<void> } | undefined;
  afterEach(async () => {
    running?.close();
    running = undefined;
    await passThrough?.close();
    passThrough = undefined;
  });

  it('answers exactly the four documented routes', () => {
    expect([...STARTER_ROUTES]).toEqual([
      'GET /models',
      'POST /ensure',
      'POST /release',
      'POST /unload',
    ]);
  });

  it('binds 127.0.0.1 only, and never the control server port', async () => {
    const started = await startStarter(makeStarterConfig({ port: 0 }));
    running = started;
    const address = started.starter.boundAddress();
    expect(address?.address).toBe('127.0.0.1');
    expect(address?.port).not.toBe(8799);
    // The port is ephemeral, so the request that proves the bind must come from
    // loopback itself — which is also what `tailscale serve` does.
    const probe = await starterRequest(started.port, { path: '/models' });
    expect(probe.status).toBe(200);
  });

  it('404s every route it does not have, including the control server ones', async () => {
    const started = await startStarter(makeStarterConfig({ port: 0 }));
    running = started;
    const misses = [
      ['GET', '/'],
      ['GET', '/healthz'],
      ['GET', '/stats'],
      ['GET', '/slots'],
      ['POST', '/chat'],
      ['POST', '/agent/message'],
      ['POST', '/agent/reply'],
      ['POST', '/agent/send-file'],
      ['GET', '/ensure'],
      ['POST', '/models'],
      ['GET', '/unload'],
      ['POST', '/load'],
      ['POST', '/release'], // exists, but only as POST — checked below
    ].filter(([, route]) => route !== '/release');
    for (const [method, route] of misses) {
      const response = await starterRequest(started.port, {
        method,
        path: route,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      });
      expect(response.status, `${method} ${route}`).toBe(404);
    }
    const hit = await starterRequest(started.port, {
      method: 'POST',
      path: '/release',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'laptop' }),
    });
    expect(hit.status).toBe(200);
  });

  it('pins the pass-through to one shape: /<model name>/v1/<openai path>', () => {
    // The four control routes stay exact, and the pass-through is a separate,
    // narrower thing. If either grows, this fails rather than a reviewer.
    expect([...STARTER_ROUTES]).toHaveLength(4);
    expect(STARTER_PASSTHROUGH_SHAPE).toBe('/<model name>/v1/<openai path>');
    const accepts: Array<[string, string, string]> = [
      ['/gemma-iq3s/v1/chat/completions', 'gemma-iq3s', '/v1/chat/completions'],
      ['/gemma-iq3s/v1/models', 'gemma-iq3s', '/v1/models'],
      // The `token_count: count_tokens` tokenizer, which the laptop calls on the
      // same base URL as the chat.
      ['/gemma-iq3s/v1/messages/count_tokens', 'gemma-iq3s', '/v1/messages/count_tokens'],
      ['/maya-m2/v1/chat/completions?user=1', 'maya-m2', '/v1/chat/completions'],
    ];
    for (const [url, model, upstreamPath] of accepts) {
      const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';
      expect(starterPassThroughRoute(url), url).toEqual({ model, upstreamPath, query });
    }
    // Everything the starter has always 404ed, plus the shapes that would make
    // the pass-through a general proxy: a path with no model, an Ollama route
    // (Ollama is never servable, so a laptop has no reason to ask for it),
    // folder navigation, a name carrying a separator or a port, and a tail too
    // short to be a real OpenAI path.
    for (const url of [
      '/',
      '/models',
      '/healthz',
      '/ensure',
      '/chat',
      '/agent/message',
      '/api/chat',
      '/api/generate',
      '/v1/chat/completions',
      '/gemma-iq3s',
      '/gemma-iq3s/',
      '/gemma-iq3s/v1',
      '/gemma-iq3s/v1/',
      '/../v1/models',
      '/./v1/models',
      '/gemma-iq3s/v1/../models',
      '/gemma-iq3s/v1/../../x',
      '/gemma-iq3s/v1/chat/completions/../admin',
      '/gemma:cloud/v1/models',
      '/gemma%2Fadmin/v1/models',
      '/gemma admin/v1/models',
    ]) {
      expect(starterPassThroughRoute(url), url).toBeNull();
    }
  });

  it('the pass-through can only reach models the starter itself calls remote: true', async () => {
    const fixture = await startPassThroughStarter();
    passThrough = fixture;
    // A hand-written entry CAN point at a port Forge uses for itself, and at
    // Ollama's daemon port: those are perfectly good URLs, and they are not
    // models. `starter-lookalike` names the starter's own port, which would make
    // the forwarder a loop.
    fixture.config.models.push(
      {
        name: 'relay-lookalike',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8797',
        unload_path: '/unload',
      },
      {
        name: 'control-lookalike',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8799',
        unload_path: '/unload',
      },
      {
        name: 'starter-lookalike',
        provider: 'openai-compatible',
        endpoint: `http://127.0.0.1:${fixture.starterPort}`,
        unload_path: '/unload',
      },
      {
        name: 'ollama-lookalike',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:11434',
        unload_path: '/unload',
      },
    );
    const cases: Array<[string, number, string | undefined]> = [
      ['grok', 422, 'not_local'], // a cloud model: traffic that costs the owner
      ['cerebras', 422, 'not_local'], // an unmanaged hand-started server
      ['llama3', 422, 'ollama_not_shared'], // a daemon a laptop reaches at home
      ['claude-code', 422, 'cli_agent'],
      ['relay-lookalike', 422, 'service_port'], // the cloud relay's port
      ['control-lookalike', 422, 'service_port'], // the control server's port
      ['starter-lookalike', 422, 'service_port'], // the starter's own port
      ['ollama-lookalike', 422, 'service_port'], // Ollama's daemon port
      ['8123', 404, undefined], // a raw port, named as if it were a model
      ['whatever-the-laptop-invented', 404, undefined],
    ];
    for (const [name, status, reason] of cases) {
      const response = await starterRequest(fixture.starterPort, {
        method: 'POST',
        path: `/${name}/v1/chat/completions`,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status, name).toBe(status);
      if (reason) expect(response.body?.reason, name).toBe(reason);
    }
    // The part with teeth: nothing was dialed. A widened target set would have
    // reached the model server, the external, or the decoy port the laptop could
    // have smuggled into its request.
    expect(fixture.slot.requests).toHaveLength(0);
    expect(fixture.external.requests).toHaveLength(0);
    expect(fixture.decoy.requests).toHaveLength(0);
    expect(fixture.pool.pinsTaken).toBe(0);
  });

  it('pulls in no chat, agent or inference code', () => {
    const offenders: string[] = [];
    for (const modules of STARTER_MODULES) {
      for (const specifier of importedSpecifiers(read(...modules))) {
        if (
          specifier.includes('/llm/') ||
          specifier.includes('ControlChatProxy') ||
          specifier.includes('agentRoutes') ||
          specifier.includes('agentFileRoute') ||
          specifier.includes('agentVerdictRoute') ||
          specifier.includes('agentInbound') ||
          specifier.includes('handleChat')
        ) {
          offenders.push(`${modules.join('/')} -> ${specifier}`);
        }
      }
    }
    // `controlHttp` is shared with the control server for sendJson/readJson/
    // errText. Its chat half (`handleChat`, which needs ProxyError from
    // src/llm/ControlChatProxy) is reached only through ControlServer's own
    // route, so reusing the helpers costs the starter no chat behaviour — but
    // a new import here is exactly the creep this row is meant to catch.
    expect(offenders).toEqual([]);
  });

  it('binds loopback in source as well as in fact', () => {
    const source = read('backend', 'ModelStarterServer.ts');
    const listens = [...source.matchAll(/\.listen\(/g)].map(
      (match) => match[0],
    );
    expect(listens, 'the starter delegates all binding to TailnetListener').toEqual([]);
    expect(read('backend', 'TailnetListener.ts')).toContain(".listen(options.port, '127.0.0.1'");
  });

  it('leaves the :8799 control server routes untouched', () => {
    const source = read('backend', 'ControlServer.ts');
    const routes = new Set<string>(
      [...source.matchAll(/path === '\/([a-z]+)'/g)].map((match) => `/${match[1]}`),
    );
    if (/path\.startsWith\('\/agent\/'\)/.test(source)) routes.add('/agent/*');
    expect([...routes].sort()).toEqual([
      '/agent/*',
      '/chat',
      '/ensure',
      '/healthz',
      '/models',
      '/release',
      '/stats',
      '/unload',
    ]);
    expect(source).toContain(".listen(port, '127.0.0.1'");
  });
});
