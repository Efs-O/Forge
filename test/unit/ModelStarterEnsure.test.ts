/**
 * What the model starter may serve, and what `POST /ensure` does
 * (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md, "Which models are remotely
 * servable" and "Ensure for…").
 *
 * The servability matrix is the whole of criterion 6: a laptop reading its own
 * config wrong must be refused with a reason, and the refusal must happen
 * before anything is loaded or evicted, so a wrong guess cannot cost the owner
 * a model it was using. The ensure tests then pin the two things the laptop
 * actually needs: the port a llama.cpp slot really landed on (problem 3), and
 * exactly one pin plus one control hold per lease.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  buildStarterModelEntry,
  ensureForRemote,
  remoteServability,
} from '../../src/backend/ModelStarterEnsure';
import { ExternalBusyError } from '../../src/backend/poolAcquisition';
import { ModelStarterLeases } from '../../src/backend/ModelStarterLeases';
import type { ModelLifecycleContext } from '../../src/backend/ControlModelLifecycle';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import {
  FakeStarterPool,
  makeLifecycleContext,
  makeStarterConfig,
  startStarter,
  starterPost,
  starterRequest,
} from '../support/modelStarterHarness';

const byName = (config: ForgeConfig, name: string): ModelConfig =>
  config.models.find((model) => model.name === name)!;

describe('remoteServability', () => {
  const config = makeStarterConfig();
  const starter = config.model_starter!;

  it.each([
    ['gemma-iq3s', true, 'llama.cpp'],
    ['gemma-iq2xs', true, 'llama.cpp'],
    ['strata-iq3s', true, 'managed-external'],
    ['maya-m2', true, 'managed-external'],
    ['strata-offacl', true, 'managed-external'],
    ['cerebras', false, null],
    ['grok', false, null],
    ['llama3', false, null],
    ['claude-code', false, null],
  ])('%s is remotely servable? %s (%s)', (name, remote, kind) => {
    const result = remoteServability(byName(config, name), config, starter);
    expect(result.remote).toBe(remote);
    expect(result.kind).toBe(kind);
  });

  it('gives every refusal a reason from the documented set', () => {
    const reasons = config.models.map((model) => ({
      name: model.name,
      ...remoteServability(model, config, starter),
    }));
    expect(reasons.filter((entry) => !entry.remote)).toEqual([
      {
        name: 'cerebras',
        remote: false,
        kind: null,
        port: null,
        port_shared: false,
        reason: 'not_local',
      },
      {
        name: 'grok',
        remote: false,
        kind: null,
        port: null,
        port_shared: false,
        reason: 'not_local',
      },
      {
        name: 'llama3',
        remote: false,
        kind: null,
        port: null,
        port_shared: false,
        reason: 'ollama_not_shared',
      },
      {
        name: 'claude-code',
        remote: false,
        kind: null,
        port: null,
        port_shared: false,
        reason: 'cli_agent',
      },
    ]);
  });

  it('refuses a model that points at a port Forge uses for itself, or at no port', () => {
    // A hand-written entry CAN name a port Forge listens on itself: the URL is
    // perfectly good and the model is not. Forwarding to the control server, the
    // cloud relay, the starter's own surface or Ollama's daemon is not serving a
    // model, and the laptop would get an answer from something that is not it.
    const withServices = {
      ...config,
      cloud_relay: { enabled: true, port: 8797, models: [] },
      // The starter's own port, which in a real config is 8798 (the schema
      // default) and is the port the listener is bound to.
      model_starter: { ...config.model_starter!, port: 8798 },
    } as ForgeConfig;
    const pointingAt = (endpoint: string): ModelConfig => ({
      name: 'pointing',
      provider: 'openai-compatible',
      endpoint,
      unload_path: '/unload',
    });
    for (const endpoint of [
      'http://127.0.0.1:8797',
      'http://127.0.0.1:8799',
      'http://127.0.0.1:11434',
      'http://127.0.0.1:8798',
    ]) {
      expect(
        remoteServability(pointingAt(endpoint), withServices, withServices.model_starter!),
        endpoint,
      ).toMatchObject({ remote: false, kind: null, port: null, reason: 'service_port' });
    }
    // A starter on a non-default port is refused by its ACTUAL port, not by 8798:
    // `model_starter.port` is the port the listener binds, so it is the port a
    // forward would loop back into.
    const elsewhere = makeStarterConfig({ port: 12345 });
    expect(
      remoteServability(
        pointingAt('http://127.0.0.1:12345'),
        elsewhere,
        elsewhere.model_starter!,
      ),
    ).toMatchObject({ remote: false, reason: 'service_port' });
    // No port at all: nothing to dial directly and nothing to forward to, which
    // is the one case `port_not_shared` still names.
    expect(
      remoteServability(
        { name: 'no-endpoint', provider: 'openai-compatible', unload_path: '/unload' },
        withServices,
        starter,
      ),
    ).toMatchObject({ remote: false, port: null, port_shared: false, reason: 'port_not_shared' });
    // A llama.cpp pool whose slot range lands on a service port is refused too:
    // the pass-through could otherwise forward a chat into the control server.
    const overlapping = { ...config, llama_server: { port: 8799 } } as ForgeConfig;
    expect(
      remoteServability(
        byName(overlapping, 'gemma-iq3s'),
        overlapping,
        overlapping.model_starter!,
      ),
    ).toMatchObject({ remote: false, reason: 'service_port' });
  });

  it('serves a llama.cpp model even when no slot port is shared, and says so', () => {
    // Since the pass-through, `shared_ports` does not decide whether a model can
    // be served — it decides whether a laptop that DIALS the model port (every
    // `remote_start` entry written before the pass-through) can still reach it.
    const partial = makeStarterConfig({ sharedPorts: [8080, 8081, 8090] });
    expect(
      remoteServability(byName(partial, 'gemma-iq3s'), partial, partial.model_starter!),
    ).toMatchObject({ remote: true, kind: 'llama.cpp', port: null, port_shared: false });
    // Four slots means 8080-8083; listing them all is what makes the direct road
    // open, not what makes the model servable.
    const whole = makeStarterConfig({ sharedPorts: [8080, 8081, 8082, 8083] });
    expect(
      remoteServability(byName(whole, 'gemma-iq3s'), whole, whole.model_starter!),
    ).toMatchObject({ remote: true, kind: 'llama.cpp', port_shared: true });
    // A one-slot pool needs only its own port for the direct road.
    const single = makeStarterConfig({ sharedPorts: [8080] });
    single.max_simultaneous_models = 1;
    expect(
      remoteServability(byName(single, 'gemma-iq3s'), single, single.model_starter!),
    ).toMatchObject({ remote: true, kind: 'llama.cpp', port_shared: true });
    // A managed external whose port is not shared is served too, and reports the
    // direct road as closed — `strata-offacl` is exactly that case.
    expect(remoteServability(byName(config, 'strata-offacl'), config, starter)).toMatchObject({
      remote: true,
      kind: 'managed-external',
      port: 8095,
      port_shared: false,
    });
  });
});

describe('GET /models', () => {
  let running: { close: () => void } | undefined;
  afterEach(() => {
    running?.close();
    running = undefined;
  });

  it('reports kind, port, context, capabilities, loaded and leasedBy per model', async () => {
    const config = makeStarterConfig({ port: 0 });
    const strata = config.models.find((model) => model.name === 'strata-iq3s')!;
    strata.model = 'qwen3.8-flash-next-abliterated-iq3_s';
    strata.token_count = 'count_tokens';
    strata.reasoning_effort = 'xhigh';
    const started = await startStarter(config);
    running = started;
    started.pool.loaded.set('gemma-iq3s', 8082);
    started.leases.grant({
      client: 'laptop-1',
      model: 'gemma-iq3s',
      port: 8082,
      kind: 'llama.cpp',
      release: () => {},
    });
    const response = await starterRequest(started.port, { path: '/models' });
    expect(response.status).toBe(200);
    const models = response.body!.models as Array<Record<string, unknown>>;
    expect(models.map((model) => model.name)).toEqual([
      'gemma-iq3s',
      'gemma-iq2xs',
      'strata-iq3s',
      'maya-m2',
      'strata-offacl',
      'cerebras',
      'grok',
      'llama3',
      'claude-code',
    ]);
    const loaded = models.find((model) => model.name === 'gemma-iq3s')!;
    expect(loaded).toMatchObject({
      kind: 'llama.cpp',
      // The slot port it actually holds, not the one the laptop guessed.
      port: 8082,
      // 131072 / n_parallel 4 — what the laptop must set num_ctx to.
      context: 32768,
      loaded: true,
      leasedBy: ['laptop-1'],
      remote: true,
      // 8082 is inside the shared range, so a laptop dialing it directly lands.
      port_shared: true,
    });
    const external = models.find((model) => model.name === 'strata-iq3s')!;
    expect(external).toMatchObject({
      kind: 'managed-external',
      port: 8090,
      // An external this window does not spawn reports its configured num_ctx.
      context: 262144,
      loaded: false,
      remote: true,
      display_name: 'Qwen Flash-Next (desktop Strata)',
      // The three fields a laptop cannot guess and did not used to get: the
      // served id, the tokenizer and the reasoning default. Fields, not routes.
      model: 'qwen3.8-flash-next-abliterated-iq3_s',
      token_count: 'count_tokens',
      reasoning_effort: 'xhigh',
    });
    expect(external.capabilities).toContain('tool-call');
    // A model that sets none of them reports none of them, so the laptop writes
    // what it sees rather than inventing a default.
    const plain = models.find((model) => model.name === 'maya-m2')!;
    expect(Object.keys(plain)).not.toContain('model');
    expect(Object.keys(plain)).not.toContain('token_count');
    expect(Object.keys(plain)).not.toContain('reasoning_effort');
    const refused = models.filter((model) => model.remote === false);
    expect(refused.map((model) => [model.name, model.reason, model.kind])).toEqual([
      ['cerebras', 'not_local', null],
      ['grok', 'not_local', null],
      ['llama3', 'ollama_not_shared', null],
      ['claude-code', 'cli_agent', null],
    ]);
  });
});

describe('POST /ensure, /release and /unload', () => {
  let running: { close: () => void } | undefined;
  afterEach(() => {
    running?.close();
    running = undefined;
  });

  it('loads a llama.cpp model and reports the slot port it got', async () => {
    const config = makeStarterConfig({ port: 0 });
    const started = await startStarter(config);
    running = started;
    const first = await starterPost(started.port, '/ensure', {
      client: 'laptop-1',
      model: 'gemma-iq3s',
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      model: 'gemma-iq3s',
      port: 8080,
      kind: 'llama.cpp',
    });
    expect(Number(first.body!.expiresAt)).toBeGreaterThan(Date.now());
    expect(started.pool.pinsTaken).toBe(1);
  });

  it('refuses a model it cannot serve with 422 and evicts nothing', async () => {
    const config = makeStarterConfig({ port: 0 });
    config.models.push({
      name: 'control-lookalike',
      provider: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8799',
      unload_path: '/unload',
    });
    const started = await startStarter(config);
    running = started;
    started.pool.loaded.set('gemma-iq3s', 8080);
    for (const model of ['grok', 'llama3', 'claude-code', 'cerebras', 'control-lookalike']) {
      const response = await starterPost(started.port, '/ensure', {
        client: 'laptop-1',
        model,
      });
      expect(response.status, model).toBe(422);
      expect(response.body!.reason, model).toBeTruthy();
    }
    // The refusal happens before any capacity decision: the desktop's loaded
    // model is still there, unreleased and unharmed.
    expect(started.pool.loadedModelNames()).toEqual(['gemma-iq3s']);
    expect(started.pool.releases).toEqual([]);
    expect(started.pool.pinsTaken).toBe(0);
  });

  it('starts a managed external through prepareExternal and reports its port', async () => {
    const config = makeStarterConfig({ port: 0 });
    const started = await startStarter(config);
    running = started;
    const response = await starterPost(started.port, '/ensure', {
      client: 'laptop-1',
      model: 'maya-m2',
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ kind: 'managed-external', port: 8070 });
    expect(started.pool.prepareExternalCalls).toEqual(['maya-m2']);
    expect(started.pool.pinsTaken).toBe(1);
  });

  it("/release drops the client's leases and answers with the models freed", async () => {
    const config = makeStarterConfig({ port: 0 });
    const started = await startStarter(config);
    running = started;
    await starterPost(started.port, '/ensure', { client: 'laptop-1', model: 'gemma-iq3s' });
    const released = await starterPost(started.port, '/release', { client: 'laptop-1' });
    expect(released.status).toBe(200);
    expect(released.body).toEqual({ released: ['gemma-iq3s'] });
    expect(started.pool.unpins).toBe(1);
    const other = await starterPost(started.port, '/release', { client: 'nobody' });
    expect(other.body).toEqual({ released: [] });
  });

  it("/unload releases the caller's lease, then unloads the model", async () => {
    const config = makeStarterConfig({ port: 0 });
    const started = await startStarter(config);
    running = started;
    await starterPost(started.port, '/ensure', { client: 'laptop-1', model: 'gemma-iq3s' });
    const unloaded = await starterPost(started.port, '/unload', {
      client: 'laptop-1',
      model: 'gemma-iq3s',
    });
    expect(unloaded.status).toBe(200);
    expect(unloaded.body).toMatchObject({ unloaded: true });
    expect(started.pool.unpins).toBe(1);
    expect(started.pool.releases).toEqual(['gemma-iq3s']);
    expect(started.leases.hasLease('gemma-iq3s')).toBe(false);
  });

  it('/unload refuses while a desktop turn or another client still holds it', async () => {
    const config = makeStarterConfig({ port: 0 });
    const started = await startStarter(config);
    running = started;
    await starterPost(started.port, '/ensure', { client: 'laptop-a', model: 'gemma-iq3s' });
    started.pool.busyNames.add('gemma-iq3s'); // a desktop turn is using it
    const refused = await starterPost(started.port, '/unload', {
      client: 'laptop-a',
      model: 'gemma-iq3s',
    });
    expect(refused.status).toBe(409);
    expect(refused.body!.error).toMatch(/in use by a desktop turn or another client/);
    expect(refused.body!.busyModel).toEqual(['gemma-iq3s']);
    // The asking client still gave up its claim, and nothing was unloaded.
    expect(started.leases.hasLease('gemma-iq3s')).toBe(false);
    expect(started.pool.releases).toEqual([]);
  });
});

describe('ensureForRemote', () => {
  function direct(ttlMs = 600_000) {
    let clock = 1_700_000_000_000;
    const config = makeStarterConfig();
    const pool = new FakeStarterPool();
    const ctx: ModelLifecycleContext = makeLifecycleContext(config, pool);
    const leases = new ModelStarterLeases(() => ttlMs, () => clock);
    const call = async (client: string, model: string) => {
      const servability = remoteServability(byName(config, model), config, config.model_starter!);
      return ensureForRemote({ ctx, pool, leases, client, model, servability });
    };
    return {
      config,
      pool,
      ctx,
      leases,
      call,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('takes one pin and one control hold per lease, not one per heartbeat', async () => {
    const { pool, ctx, call, advance, leases } = direct();
    const first = await call('laptop-1', 'gemma-iq3s');
    expect(first.status).toBe(200);
    expect(ctx.holds.get('gemma-iq3s')).toBe(1);
    advance(200_000); // the laptop's next heartbeat, TTL/3 later
    const second = await call('laptop-1', 'gemma-iq3s');
    expect(second.status).toBe(200);
    expect(second.body!.leaseId).toBe(first.body!.leaseId);
    expect(ctx.holds.get('gemma-iq3s')).toBe(1);
    expect(pool.pinsTaken).toBe(1);
    expect(Number(second.body!.expiresAt)).toBeGreaterThan(Number(first.body!.expiresAt));
    // 599_000 more on top of the heartbeat: still inside the renewed lease.
    advance(599_000);
    expect(leases.hasLease('gemma-iq3s')).toBe(true);
    advance(1_001);
    leases.expireNow();
    expect(leases.hasLease('gemma-iq3s')).toBe(false);
    expect(pool.unpins).toBe(1);
    expect(ctx.holds.size).toBe(0);
  });

  it('re-ensures when the leased model is no longer ready, without double-pinning', async () => {
    const { pool, call, leases } = direct();
    const first = await call('laptop-1', 'gemma-iq3s');
    pool.notReady.add('gemma-iq3s'); // its server died while the lease lived
    const again = await call('laptop-1', 'gemma-iq3s');
    expect(again.status).toBe(200);
    expect(again.body!.leaseId).not.toBe(first.body!.leaseId);
    expect(pool.pinsTaken).toBe(2);
    expect(pool.unpins).toBe(1); // the stale lease's pin, and only that one
    expect(leases.size).toBe(1);
  });

  it("switching models frees the laptop's own previous model before loading", async () => {
    const { pool, call } = direct();
    await call('laptop-1', 'strata-iq3s');
    // With the old lease still held, freeVramForExternal would count Strata
    // busy and refuse the laptop's own switch.
    const switched = await call('laptop-1', 'gemma-iq2xs');
    expect(switched.status).toBe(200);
    expect(pool.prepareExternalCalls).toEqual(['strata-iq3s']);
    expect(pool.unpins).toBe(1);
    expect(switched.body).toMatchObject({ model: 'gemma-iq2xs', port: 8080, kind: 'llama.cpp' });
  });

  it('reports a busy refusal as 409 naming the blocking model', async () => {
    const busyExternal = direct();
    busyExternal.pool.prepareExternalError = new ExternalBusyError(
      'Cannot load "maya-m2" beside strata-iq3s: a turn is running on it.',
      ['strata-iq3s'],
    );
    const refused = await busyExternal.call('laptop-1', 'maya-m2');
    expect(refused.status).toBe(409);
    expect(refused.body!.busyModel).toEqual(['strata-iq3s']);
    // The pin taken before the attempt is gone again: a failed ensure must not
    // leave a model protected with nothing holding it.
    expect(busyExternal.pool.pinsTaken).toBe(1);
    expect(busyExternal.pool.unpins).toBe(1);

    const fullCapacity = direct();
    fullCapacity.config.max_simultaneous_models = 1;
    fullCapacity.pool.loaded.set('gemma-iq3s', 8080);
    fullCapacity.pool.busyNames.add('gemma-iq3s');
    const swap = await fullCapacity.call('laptop-1', 'gemma-iq2xs');
    expect(swap.status).toBe(409);
    expect(swap.body!.busyModel).toEqual(['gemma-iq3s']);
    expect(fullCapacity.pool.loadedModelNames()).toEqual(['gemma-iq3s']);
    expect(fullCapacity.pool.unpins).toBe(1);
  });

  it("passes the desktop's own failure through as 502, with its text", async () => {
    const { pool, call } = direct();
    pool.prepareExternalError = new Error(
      '"maya-m2" was started but did not become reachable within 120s',
    );
    const failed = await call('laptop-1', 'maya-m2');
    expect(failed.status).toBe(502);
    expect(failed.body!.error).toMatch(/did not become reachable within 120s/);
    expect(pool.unpins).toBe(1);
    const acquireFailure = direct();
    acquireFailure.pool.acquireError = new Error('spawn failed: port occupied');
    const second = await acquireFailure.call('laptop-1', 'gemma-iq3s');
    expect(second.status).toBe(502);
    expect(second.body!.error).toMatch(/port occupied/);
    expect(acquireFailure.pool.pinsTaken).toBe(1);
    expect(acquireFailure.pool.unpins).toBe(1);
    expect(acquireFailure.ctx.holds.size).toBe(0);
  });

  it('builds a /models entry with the same servability /ensure uses', () => {
    const config = makeStarterConfig();
    const pool = new FakeStarterPool();
    const leases = new ModelStarterLeases(() => 600_000);
    const entry = buildStarterModelEntry(byName(config, 'strata-offacl'), {
      config,
      starter: config.model_starter!,
      pool: pool as never,
      leases,
    });
    expect(entry).toMatchObject({
      name: 'strata-offacl',
      // Its port is outside `shared_ports`, so the direct road is closed — but
      // the pass-through reaches it on loopback, so it is servable either way.
      remote: true,
      kind: 'managed-external',
      port: 8095,
      port_shared: false,
      loaded: false,
      leasedBy: [],
    });
    const servable = buildStarterModelEntry(byName(config, 'strata-iq3s'), {
      config,
      starter: config.model_starter!,
      pool: pool as never,
      leases,
    });
    expect(servable).toMatchObject({ remote: true, kind: 'managed-external', port: 8090 });
  });
});
