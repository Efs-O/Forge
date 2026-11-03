/**
 * The pass-through: model traffic on the starter's ONE shared port
 * (docs/plans/V1_FINISH_PLAN.md lane 3 phase 3.1, acceptance criteria 3 and 4).
 *
 * What has to be proven is the wire, so every test runs against a REAL loopback
 * listener and REAL fake model servers rather than a stubbed forwarder: the
 * model prefix has to be gone by the time the request reaches the model server,
 * the answer has to arrive chunk by chunk rather than as one buffered body, and
 * the port that gets dialed has to be the one the desktop knows — never one the
 * laptop named in its own request. The fake servers record what they saw, so
 * `decoy.requests.length === 0` is as much of the test as `slot.requests[0]` is:
 * a forwarder that guessed a port from the Host header would have knocked on the
 * decoy's door and never reached the model.
 *
 * The two disconnects are the other half of what this file guards. A laptop that
 * hangs up mid-stream has to stop generating on the desktop, and so does turning
 * sharing off — otherwise a stream outlives the window that was serving it and
 * holds the GPU for a chat nobody is reading. Both are tested by counting what
 * the fake server saw close early, not by trusting the abort wiring.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  STARTER_PASSTHROUGH_BODY_BYTES,
} from '../../src/backend/ModelStarterPassThrough';
import {
  starterPost,
  starterRequest,
  starterStreamRequest,
  startPassThroughStarter,
  waitForCondition,
} from '../support/modelStarterHarness';

const CHAT_BODY = JSON.stringify({ model: 'gemma-iq3s', stream: true });

/** The pass-through path for one model: what a laptop whose `endpoint` is the
 *  shared port plus the model name actually sends. */
const chatPath = (model: string, query = ''): string =>
  `/${model}/v1/chat/completions${query}`;

/** What `startPassThroughStarter` hands back, typed once so each test reads as
 *  a fixture rather than as a pile of casts. */
type PassThroughFixture = Awaited<ReturnType<typeof startPassThroughStarter>>;

describe('the pass-through forwards model traffic through the shared port', () => {
  let fixture: PassThroughFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it('streams a llama.cpp chat, unbuffered, with the model prefix removed', async () => {
    fixture = await startPassThroughStarter();
    const stream = await starterStreamRequest(fixture.starterPort, {
      method: 'POST',
      path: chatPath('gemma-iq3s'),
      headers: { 'content-type': 'application/json' },
      body: CHAT_BODY,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    // Buffered would have said how long the answer was. It did not: the starter
    // is piping, not collecting, so the laptop sees each token as it lands.
    expect(stream.headers['content-length']).toBeUndefined();
    const first = await stream.read(3);
    expect(first.length).toBe(3);
    // Three chunks landed while the desktop was still generating the rest.
    expect(fixture.slot.open()).toBe(1);
    const ended = await stream.finished;
    expect(ended.endedEarly).toBe(false);
    expect(ended.chunks.length).toBeGreaterThan(3);
    expect(fixture.slot.requests).toHaveLength(1);
    const arrived = fixture.slot.requests[0]!;
    expect(arrived.path).toBe('/v1/chat/completions');
    expect(arrived.method).toBe('POST');
    // Byte for byte: the model server got the body the laptop sent, not a
    // re-serialised version of it.
    expect(arrived.body).toBe(CHAT_BODY);
    expect(arrived.headers['content-type']).toContain('application/json');
    expect(arrived.headers.host).toBe(`127.0.0.1:${fixture.pool.loaded.get('gemma-iq3s')}`);
  });

  it('streams a managed external through on its fixed endpoint port', async () => {
    fixture = await startPassThroughStarter();
    const stream = await starterStreamRequest(fixture.starterPort, {
      method: 'POST',
      path: chatPath('strata-iq3s'),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'strata-iq3s', stream: true }),
    });
    expect(stream.status).toBe(200);
    await stream.read(2);
    const ended = await stream.finished;
    expect(ended.endedEarly).toBe(false);
    expect(fixture.external.requests).toHaveLength(1);
    expect(fixture.external.requests[0]!.path).toBe('/v1/chat/completions');
    expect(fixture.slot.requests).toHaveLength(0);
  });

  it('forwards the query string, and dials the port the desktop knows', async () => {
    fixture = await startPassThroughStarter();
    // A laptop can put a port in the Host header, in the path or in the query —
    // none of them may move the port the starter dials, because that port comes
    // from the desktop's pool and config. `decoy` is the port being smuggled.
    const response = await starterRequest(fixture.starterPort, {
      path: `/gemma-iq3s/v1/models?port=${fixture.decoy.port}`,
      headers: { host: `127.0.0.1:${fixture.decoy.port}` },
    });
    expect(response.status).toBe(200);
    expect(fixture.slot.requests).toHaveLength(1);
    expect(fixture.slot.requests[0]!.path).toBe(`/v1/models?port=${fixture.decoy.port}`);
    expect(fixture.decoy.requests).toHaveLength(0);
    expect(fixture.external.requests).toHaveLength(0);
  });

  it('serves a model whose port nobody shares, and says the direct road is closed', async () => {
    fixture = await startPassThroughStarter();
    const listed = (await starterRequest(fixture.starterPort, { path: '/models' })).body!;
    const models = listed.models as Array<Record<string, unknown>>;
    // The same body has to carry the port a laptop's model requests arrive on —
    // the starter's own — because `Forge: Connect to my desktop` writes that
    // number into every `endpoint` it adds and has no other way to learn it. A
    // desktop that does not send it is how Connect knows to say "update Forge on
    // the desktop" instead of writing entries that 404 on every request.
    expect(listed.shared_port).toBe(fixture.starterPort);
    const llama = models.find((model) => model.name === 'gemma-iq3s')!;
    // The pass-through is why `remote` no longer asks whether the port is
    // shared: this slot's ephemeral port is in nobody's `shared_ports`.
    expect(llama.remote).toBe(true);
    expect(llama.port_shared).toBe(false);
    expect(llama.port).toBe(fixture.pool.loaded.get('gemma-iq3s'));
    const external = models.find((model) => model.name === 'strata-iq3s')!;
    expect(external.remote).toBe(true);
    expect(external.port_shared).toBe(false);
    expect(external.port).toBe(fixture.external.port);
    // A model whose port IS shared still reports it, so an old laptop entry that
    // dials the port directly can be told its route is intact.
    const maya = models.find((model) => model.name === 'maya-m2')!;
    expect(maya.remote).toBe(true);
    expect(maya.port_shared).toBe(true);
    const response = await starterRequest(fixture.starterPort, {
      path: '/gemma-iq3s/v1/models',
    });
    expect(response.status).toBe(200);
    expect(fixture.slot.requests).toHaveLength(1);
  });

  it('a model that is not loaded answers 409 naming /ensure, and starts nothing', async () => {
    fixture = await startPassThroughStarter();
    const before = fixture.pool.loadedModelNames();
    const response = await starterRequest(fixture.starterPort, {
      path: '/gemma-iq2xs/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemma-iq2xs' }),
    });
    expect(response.status).toBe(409);
    expect(response.body!.error).toMatch(/call \/ensure first/);
    expect(response.body!.model).toBe('gemma-iq2xs');
    // The pass-through is a forwarder, not a loader: it took no pin, started no
    // server and evicted nothing, so a laptop that forgot to ensure costs the
    // desktop nothing.
    expect(fixture.pool.pinsTaken).toBe(0);
    expect(fixture.pool.prepareExternalCalls).toEqual([]);
    expect(fixture.pool.loadedModelNames()).toEqual(before);
    expect(fixture.slot.requests).toHaveLength(0);
    expect(fixture.external.requests).toHaveLength(0);
  });

  it('a laptop hanging up mid-stream stops the desktop generating', async () => {
    fixture = await startPassThroughStarter();
    const stream = await starterStreamRequest(fixture.starterPort, {
      method: 'POST',
      path: chatPath('gemma-iq3s'),
      headers: { 'content-type': 'application/json' },
      body: CHAT_BODY,
    });
    await stream.read(2);
    stream.hangUp();
    const ended = await stream.finished;
    expect(ended.endedEarly).toBe(true);
    // The proof is on the desktop's side: its model server saw the connection
    // close before the answer ended, so it stopped writing.
    expect(await waitForCondition(() => fixture!.slot.sawEarlyClose())).toBe(true);
    expect(await waitForCondition(() => fixture!.slot.open() === 0)).toBe(true);
    expect(fixture.slot.requests).toHaveLength(1);
  });

  it('turning sharing off ends every stream this window was forwarding', async () => {
    fixture = await startPassThroughStarter();
    const stream = await starterStreamRequest(fixture.starterPort, {
      method: 'POST',
      path: chatPath('gemma-iq3s'),
      headers: { 'content-type': 'application/json' },
      body: CHAT_BODY,
    });
    const ending = stream.finished;
    await stream.read(1);
    // `applyConfig` with the starter off, and `dispose()`, both close the
    // listener; the listener's close is what aborts the streams.
    fixture.starter.dispose();
    const ended = await ending;
    expect(ended.endedEarly).toBe(true);
    expect(await waitForCondition(() => fixture!.slot.sawEarlyClose())).toBe(true);
    expect(await waitForCondition(() => fixture!.slot.open() === 0)).toBe(true);
  });

  it('a body over the pass-through cap is 413, while the control routes keep 4 KB', async () => {
    fixture = await startPassThroughStarter();
    const tooBig = await starterRequest(fixture.starterPort, {
      method: 'POST',
      path: chatPath('gemma-iq3s'),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemma-iq3s', pad: 'x'.repeat(STARTER_PASSTHROUGH_BODY_BYTES + 1) }),
    });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body?.error).toMatch(new RegExp(`at most ${STARTER_PASSTHROUGH_BODY_BYTES}`));
    expect(fixture.slot.requests).toHaveLength(0);
    // The cap that stops a flood on `/ensure` must not stop an image on a chat
    // request: 4 KB is refused here, 5 KB is not.
    const small = await starterRequest(fixture.starterPort, {
      method: 'POST',
      path: chatPath('gemma-iq3s'),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemma-iq3s', pad: 'x'.repeat(5000) }),
    });
    expect(small.status).not.toBe(413);
    const control = await starterPost(fixture.starterPort, '/release', {
      client: 'l'.repeat(5000),
    });
    expect(control.status).toBe(413);
    expect(control.body?.error).toMatch(/at most 4096/);
  });

  it('keeps the browser guards on the streamed route too', async () => {
    fixture = await startPassThroughStarter();
    const origin = await starterRequest(fixture.starterPort, {
      path: chatPath('gemma-iq3s'),
      method: 'POST',
      headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: CHAT_BODY,
    });
    expect(origin.status).toBe(403);
    const named = await starterRequest(fixture.starterPort, {
      path: '/gemma-iq3s/v1/models',
      headers: { host: 'desktop-1.tailnet.ts' },
    });
    expect(named.status).toBe(403);
    expect(named.body?.error).toMatch(/IP address or localhost/);
    const notJson = await starterRequest(fixture.starterPort, {
      method: 'POST',
      path: chatPath('gemma-iq3s'),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'model=gemma-iq3s',
    });
    expect(notJson.status).toBe(415);
    expect(fixture.slot.requests).toHaveLength(0);
  });

  it('still reports the model port on /ensure, so old direct-dial entries work', async () => {
    fixture = await startPassThroughStarter();
    const ensured = await starterPost(fixture.starterPort, '/ensure', {
      client: 'laptop-1',
      model: 'gemma-iq3s',
    });
    expect(ensured.status).toBe(200);
    // The old laptop entry dials `endpoint`'s host with THIS port, so the answer
    // must stay the model's own port and not become the starter's.
    expect(ensured.body!.port).toBe(fixture.pool.loaded.get('gemma-iq3s'));
    expect(Number(ensured.body!.port)).not.toBe(fixture.starterPort);
    // Nothing was dialed: `/ensure` only starts and loads.
    expect(fixture.slot.requests).toHaveLength(0);
  });
});
