/**
 * The writes and the desktop reads of "Forge: Connect to my desktop"
 * (docs/plans/V1_FINISH_PLAN.md lane 3 phase 3.2, acceptance criteria 5 and 6).
 *
 * These tests drive `runConnect` against REAL loopback servers rather than a
 * stubbed fetch, because what has to be proven is the wire and the file:
 *
 * - **It writes, it never runs.** The desktop's request log is the assertion:
 *   `GET /models` and `GET /v1/models` and nothing else. A convenience that
 *   "warmed the model while importing" would fail here, not in the owner's GPU
 *   bill (`IMPORT_DESKTOP_MODELS_PLAN.md`'s CI-enforced ledger row).
 * - **An existing entry comes out byte-identical.** The seed config is written by
 *   hand, with comments, key order and a tuned `sampling` block, and the whole
 *   hand-written block has to still be in the file verbatim afterwards.
 * - **No key.** Nothing in the written file may mention a key or a secret.
 *
 * `vscode` is mocked (the vitest alias points it at `test/support/vscode.ts` and
 * this file overrides that), so the picker, the notice and its "Add them" action
 * are all driven without a window. Tailscale is never run: the CLI is injected.
 * The notice lives in `src/vscode/desktopKeepingUp.ts`; its tests are here
 * because they need the same fake desktop.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as YAML from 'yaml';
import { ForgeConfigSchema } from '../../src/config/schema';
import {
  runConnect,
  registerDesktopConnectCommands,
  DESKTOP_CONNECT_COMMAND,
  type DesktopConnectDeps,
} from '../../src/vscode/desktopConnect';
import { wireDesktopKeepingUp } from '../../src/vscode/desktopKeepingUp';
import { logger } from '../../src/util/logger';
import { listenLoopback } from '../support/listenLoopback';

const ui = vi.hoisted(() => ({
  info: [] as Array<{ message: string; actions: string[] }>,
  errors: [] as string[],
  /** Palette commands the modules under test registered, by command id. */
  handlers: {} as Record<string, () => Promise<void>>,
  /** The QuickPick label this test pretends was clicked, or `undefined` for none. */
  pick: undefined as string | undefined,
  /** What the address box came back with. */
  typed: undefined as string | undefined,
  /** The button answer for the next information message. */
  answer: undefined as string | undefined,
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (id: string, fn: unknown) => {
      ui.handlers[id] = fn as () => Promise<void>;
      return { dispose(): void {} };
    },
  },
  window: {
    // `util/logger.ts` creates its output channel at import time, so the mock has
    // to provide one before any of the modules under test can be loaded.
    createOutputChannel: () => ({
      appendLine: () => {},
      append: () => {},
      clear: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
    showInformationMessage: async (message: string, ...actions: string[]) => {
      ui.info.push({ message, actions });
      return ui.answer;
    },
    showErrorMessage: async (message: string) => {
      ui.errors.push(message);
    },
    showQuickPick: async (items: Array<{ label: string; description?: string }>) =>
      items.find((item) => item.label === ui.pick),
    showInputBox: async () => ui.typed,
  },
}));

/** The desktop's `GET /models`, in the shape `buildStarterModelEntry` answers
 *  with — including the fields an imported entry needs and the refusals with
 *  their reasons. `port_shared` is false for both: the point of the pass-through. */
const DESKTOP_MODELS = [
  {
    name: 'strata-iq3s',
    display_name: 'Qwen Flash-Next (desktop Strata)',
    kind: 'llama.cpp',
    port: null,
    port_shared: false,
    context: 262144,
    capabilities: ['tool-call', 'long-context', 'vision'],
    loaded: false,
    leasedBy: [],
    remote: true,
    model: 'qwen3.8-flash-next-abliterated-iq3_s',
    token_count: 'count_tokens',
    reasoning_effort: 'xhigh',
  },
  {
    name: 'gemma-iq3s',
    kind: 'llama.cpp',
    port: null,
    port_shared: false,
    context: 32768,
    capabilities: [],
    loaded: false,
    leasedBy: [],
    remote: true,
    token_count: 'tokenize',
  },
  {
    name: 'grok',
    kind: null,
    port: null,
    port_shared: false,
    context: 131072,
    capabilities: [],
    loaded: false,
    leasedBy: [],
    remote: false,
    reason: 'not_local',
  },
  {
    name: 'llama3',
    kind: null,
    port: null,
    port_shared: false,
    context: 131072,
    capabilities: [],
    loaded: false,
    leasedBy: [],
    remote: false,
    reason: 'ollama_not_shared',
  },
];

interface FakeDesktop {
  /** `http://127.0.0.1:<port>` of the model starter. */
  starterUrl: string;
  /** `http://127.0.0.1:<port>` of the cloud relay. */
  relayUrl: string;
  /** Every request the starter saw, as `<method> <path>`. */
  starterRequests: string[];
  relayRequests: string[];
  close(): Promise<void>;
}

/** A desktop that answers like one: the starter lists its models with its own
 *  shared port, and the relay lists its allowlist. `models`/`relayIds`/`sharedPort`
 *  let a test say "an old desktop", "no cloud models" or "a different list". */
async function startFakeDesktop(
  options: {
    models?: unknown[];
    sharedPort?: number | null;
    relayIds?: Array<{ id: string; kind: string }>;
    relayDown?: boolean;
  } = {},
): Promise<FakeDesktop> {
  const models = options.models ?? DESKTOP_MODELS;
  const relayIds = options.relayIds ?? [
    { id: 'grok-code-fast', kind: 'openai' },
    { id: 'llama3:cloud', kind: 'ollama' },
  ];
  const starterRequests: string[] = [];
  const relayRequests: string[] = [];
  const listen = async (handler: http.RequestHandler): Promise<{ server: http.Server; port: number }> => {
    const server = http.createServer(handler);
    const port = await listenLoopback(server);
    return { server, port };
  };
  let starterPort = 0;
  const starter = await listen((req, res) => {
    const route = `${req.method} ${(req.url ?? '/').split('?')[0]}`;
    starterRequests.push(route);
    if (route !== 'GET /models') {
      // Anything but a read is the defect this file's header names: a config
      // edit that starts the desktop's GPU work. Answer like the real starter
      // would for a route it does not have, so the assertion is about the log.
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `no route for ${route}` }));
      return;
    }
    const shared = options.sharedPort === undefined ? starterPort : options.sharedPort;
    const body: Record<string, unknown> = { models };
    if (shared !== null) body.shared_port = shared;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  starterPort = starter.port;
  const relay = options.relayDown
    ? { server: undefined as http.Server | undefined, port: 0 }
    : await listen((req, res) => {
        const route = `${req.method} ${(req.url ?? '/').split('?')[0]}`;
        relayRequests.push(route);
        if (route !== 'GET /v1/models') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `no route for ${route}` } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: relayIds.map((row) => ({
              id: row.id,
              owned_by: 'forge-relay',
              kind: row.kind,
            })),
          }),
        );
      });
  return {
    starterUrl: `http://127.0.0.1:${starter.port}`,
    relayUrl: `http://127.0.0.1:${relay.port}`,
    starterRequests,
    relayRequests,
    close: async () => {
      await new Promise<void>((resolve) => {
        starter.server.close(() => resolve());
      });
      if (relay.server) {
        await new Promise<void>((resolve) => {
          relay.server!.close(() => resolve());
        });
      }
    },
  };
}

/** A laptop config written by a person: comments, key order, a tuned sampling
 *  block, and a `desktop-relay` group whose endpoint is the laptop's own.
 *  `PORTS` is substituted once the fake desktop's ports are known. */
function seedConfig(starterPort: number, relayPort: number): string {
  return `# Hand-built laptop config: comments and key order must survive Connect.
active_model: gemma-iq3s
llama_server: {}
groups:
  # The relay group this laptop already uses; Connect must not rewrite it.
  desktop-relay:
    provider: openai-compatible
    endpoint: http://127.0.0.1:${relayPort}
models:
  # tuned by hand on 2026-10-20 — these bytes must come back identical:
  - name: grok-code-fast
    group: desktop-relay
    profiles: []
    sampling: { temperature: 0.7, max_tokens: 30000 }
  - name: gemma-iq3s
    provider: openai-compatible
    endpoint: http://127.0.0.1:11434/v1
    num_ctx: 32768
    sampling: { temperature: 0.3 }
`;
}

/** A config whose only entry is a `remote_start` one, for the keeping-up notice:
 *  Connect must not need a picker when the laptop already dials a desktop. */
function dialingConfig(starterUrl: string, modelName: string): string {
  return `active_model: ${modelName}
llama_server: {}
models:
  - name: ${modelName}
    provider: openai-compatible
    endpoint: ${starterUrl}/${modelName}
    num_ctx: 262144
    remote_start:
      starter: [${starterUrl}]
      model: ${modelName}
`;
}

describe('Connect to my desktop', () => {
  let directory: string;
  let configPath: string;
  let desktop: FakeDesktop;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-connect-'));
    configPath = path.join(directory, 'config.yaml');
    ui.info.length = 0;
    ui.errors.length = 0;
    ui.pick = undefined;
    ui.typed = undefined;
    ui.answer = undefined;
  });

  afterEach(async () => {
    await desktop?.close();
    desktop = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** Deps against the fake desktop: the config is re-read every time, which is
   *  what a real window does after a reload, and what makes the second run see
   *  the entries the first run wrote. */
  function depsFor(starterPort: number, relayPort: number): DesktopConnectDeps {
    return {
      getConfig: () => YAML.parse(fs.readFileSync(configPath, 'utf8')) as never,
      getConfigPath: () => configPath,
      fetchImpl: fetch,
      starterPort,
      relayPort,
      // The CLI is injected: `tailscale` is never run in tests, and a peer whose
      // address is 127.0.0.1 is how a test reaches the fake desktop by name.
      runTailscale: async () =>
        JSON.stringify({
          Peer: [
            { Self: true, Online: true, NodeName: 'laptop.', TailscaleIPs: ['127.0.0.1'] },
            { Online: true, NodeName: 'desktop.tailnet.ts', TailscaleIPs: ['127.0.0.1'] },
            { Online: false, NodeName: 'studio', TailscaleIPs: ['127.0.0.1'] },
          ],
        }),
    };
  }

  it('adds every model the desktop will serve, in one write, with no key', async () => {
    desktop = await startFakeDesktop();
    const ports = { starterPort: Number(new URL(desktop.starterUrl).port), relayPort: Number(new URL(desktop.relayUrl).port) };
    fs.writeFileSync(configPath, seedConfig(ports.starterPort, ports.relayPort));
    ui.pick = 'desktop'; // the picker's answer: the online desktop by name
    const message = await runConnect(depsFor(ports.starterPort, ports.relayPort));
    const text = fs.readFileSync(configPath, 'utf8');

    // The write is schema-valid, so the laptop's next start does not fail on it.
    const parsed = ForgeConfigSchema.parse(YAML.parse(text)) as { models: Array<Record<string, unknown>> };
    expect(parsed.models.map((model) => model.name)).toEqual([
      'grok-code-fast', // already there, still first in the file
      'gemma-iq3s', // already there
      'strata-iq3s', // new desktop entry, appended in the desktop's order
      'llama3:cloud', // new cloud entry, group only
    ]);
    // Nothing secret crossed to the laptop: the relay resolves its own tokens.
    // (`token_count` is a tokenizer name, not a credential, so the check names
    // the credential fields rather than any word containing "token".)
    expect(text).not.toMatch(/api_key|SecretStorage|Bearer|password/i);
    for (const model of parsed.models) expect(model.api_key_secret).toBeUndefined();

    // The new entry is the shared-port shape the pass-through answers.
    const strata = parsed.models.find((model) => model.name === 'strata-iq3s')!;
    expect(strata.endpoint).toBe(`${desktop.starterUrl}/strata-iq3s`);
    expect(strata.remote_start).toEqual({
      starter: [desktop.starterUrl],
      model: 'strata-iq3s',
    });
    expect(strata.num_ctx).toBe(262144);
    expect(strata.model).toBe('qwen3.8-flash-next-abliterated-iq3_s');
    expect(strata.token_count).toBe('count_tokens');
    expect(strata.reasoning_effort).toBe('xhigh');
    expect(strata.capabilities).toEqual(['tool-call', 'long-context', 'vision']);
    // `tokenize` is not copied: the shared port does not carry /tokenize.
    expect(text).not.toMatch(/token_count: tokenize/);

    // It writes and never runs: the desktop saw two reads and no POST.
    expect(desktop.starterRequests).toEqual(['GET /models']);
    expect(desktop.relayRequests).toEqual(['GET /v1/models']);

    // One write: the writer's own backup, and no temp file left behind.
    expect(fs.readdirSync(directory).sort()).toEqual(['config.yaml', 'config.yaml.bak']);

    // The hand-written bytes survived verbatim, comment included.
    expect(text).toContain(
      `  # tuned by hand on 2026-10-20 — these bytes must come back identical:
  - name: grok-code-fast
    group: desktop-relay
    profiles: []
    sampling: { temperature: 0.7, max_tokens: 30000 }`,
    );
    expect(text).toContain('# Hand-built laptop config: comments and key order must survive Connect.');
    // The group the laptop already had was not recreated or repointed.
    expect(text).toContain(`endpoint: http://127.0.0.1:${ports.relayPort}`);

    expect(message).toMatch(/added 1 desktop model and 1 cloud model/);
    expect(message).toMatch(/created the ollama-cloud group/);
    expect(message).toMatch(/2 were already there and left untouched/);
    expect(message).toMatch(
      /2 models the desktop refuses: grok \(not_local\), llama3 \(ollama_not_shared\)/,
    );
  });

  it('a second run writes nothing and says what was already there', async () => {
    desktop = await startFakeDesktop();
    const starterPort = Number(new URL(desktop.starterUrl).port);
    const relayPort = Number(new URL(desktop.relayUrl).port);
    fs.writeFileSync(configPath, seedConfig(starterPort, relayPort));
    ui.pick = 'desktop';
    const deps = depsFor(starterPort, relayPort);
    await runConnect(deps);
    const afterFirst = fs.readFileSync(configPath, 'utf8');
    ui.pick = 'desktop'; // the second run also has no config entries to copy
    const second = await runConnect(deps);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(afterFirst);
    expect(second).toMatch(/already there and left untouched/);
    // Two reads, one per run: no retry, no warm-up, no lease.
    expect(desktop.starterRequests).toEqual(['GET /models', 'GET /models']);
  });

  it('a refused address is reported with the address, not as a generic failure', async () => {
    desktop = await startFakeDesktop();
    const starterPort = Number(new URL(desktop.starterUrl).port);
    fs.writeFileSync(configPath, seedConfig(starterPort, 8797));
    ui.pick = 'desktop';
    // A desktop that is asleep: the starter's port answers nothing at all.
    const message = await runConnect({
      ...depsFor(9999, 8797),
      starterPort: 9999,
      runTailscale: async () =>
        JSON.stringify({ Peer: [{ Online: true, NodeName: 'desktop', TailscaleIPs: ['127.0.0.1'] }] }),
    });
    expect(message).toMatch(/http:\/\/127\.0\.0\.1:9999/);
    expect(message).toMatch(/Check connection/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(seedConfig(starterPort, 8797));
  });

  it('a name typed instead of an IP is refused with the schema message', async () => {
    desktop = await startFakeDesktop();
    fs.writeFileSync(configPath, seedConfig(8798, 8797));
    ui.pick = 'Type an address…';
    ui.typed = 'desktop.tailnet.ts';
    const message = await runConnect(depsFor(8798, 8797));
    expect(message).toBe('');
    expect(ui.errors.join(' ')).toMatch(/IP host/);
    expect(desktop.starterRequests).toEqual([]); // nothing was dialed
  });

  it('a desktop that reports no shared port gets no entries, and says what to do', async () => {
    desktop = await startFakeDesktop({ sharedPort: null });
    const starterPort = Number(new URL(desktop.starterUrl).port);
    const relayPort = Number(new URL(desktop.relayUrl).port);
    fs.writeFileSync(configPath, seedConfig(starterPort, relayPort));
    ui.pick = 'desktop';
    const message = await runConnect(depsFor(starterPort, relayPort));
    // Only the model that is not already in the config can be "not added":
    // `gemma-iq3s` was skipped as "already there" before this check, exactly as
    // it would be on a desktop that does report a shared port.
    expect(message).toMatch(/1 model was not added: this desktop does not report a shared port/);
    expect(message).toMatch(/update Forge on the desktop/);
    // The cloud half still landed: the relay does not depend on the pass-through.
    expect(fs.readFileSync(configPath, 'utf8')).toContain('llama3:cloud');
  });

  it('a relay that did not answer still writes the desktop models', async () => {
    desktop = await startFakeDesktop({ relayDown: true });
    const starterPort = Number(new URL(desktop.starterUrl).port);
    fs.writeFileSync(configPath, seedConfig(starterPort, 8797));
    ui.pick = 'desktop';
    // Port 1 is where nothing is listening: a test must not dial 8797, because
    // this machine may BE the desktop and its relay would answer.
    const message = await runConnect(depsFor(starterPort, 1));
    // Only the desktop models were added: the added-clause goes straight into
    // "to config.yaml" with no cloud count beside it.
    expect(message).toMatch(/added 1 desktop model to config\.yaml/);
    expect(message).toMatch(/relay did not answer \(.*\), so no cloud models were added/);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('strata-iq3s');
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('llama3:cloud');
  });
});

describe('the keeping-up notice', () => {
  let directory: string;
  let configPath: string;
  let desktop: FakeDesktop;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-connect-notice-'));
    configPath = path.join(directory, 'config.yaml');
    ui.info.length = 0;
    ui.errors.length = 0;
    ui.answer = undefined;
  });

  afterEach(async () => {
    await desktop?.close();
    desktop = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const fakeContext = (): { subscriptions: Array<{ dispose(): void }> } => ({
    subscriptions: [],
  });

  it('notices once per window, adds on "Add them", and does not nag after "Not now"', async () => {
    desktop = await startFakeDesktop({ relayDown: true });
    fs.writeFileSync(configPath, dialingConfig(desktop.starterUrl, 'gemma-iq3s'));
    const deps: DesktopConnectDeps = {
      getConfig: () => YAML.parse(fs.readFileSync(configPath, 'utf8')) as never,
      getConfigPath: () => configPath,
      fetchImpl: fetch,
      relayPort: 1, // nothing is listening there: the notice does not read the relay
    };
    ui.answer = undefined; // dismissed: "Not now"
    const context = fakeContext();
    const wiring = wireDesktopKeepingUp(context as never, deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // One notice, naming the count and the missing model, with one action.
    expect(ui.info).toHaveLength(1);
    expect(ui.info[0]!.message).toMatch(/The desktop has 1 model this laptop does not list: strata-iq3s/);
    expect(ui.info[0]!.actions).toEqual(['Add them']);
    // "Not now" is remembered for this window: the same check again is silent.
    await wiring.recheck();
    expect(ui.info).toHaveLength(1);
    // The desktop models it did not offer were not written: nothing was written.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(dialingConfig(desktop.starterUrl, 'gemma-iq3s'));
    // And the notice never POSTs: it reads once, and "Not now" stops this window
    // from reading again — a laptop that dismissed the notice is not made to pay
    // for another desktop round trip on every check.
    expect(desktop.starterRequests).toEqual(['GET /models']);

    // Now the same window, asked again after the owner clicked "Add them".
    ui.answer = 'Add them';
    const second = fakeContext();
    const wiring2 = wireDesktopKeepingUp(second as never, deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ui.info.length).toBeGreaterThan(1);
    const text = fs.readFileSync(configPath, 'utf8');
    expect(text).toContain('strata-iq3s');
    expect(ForgeConfigSchema.parse(YAML.parse(text)).models.map((model) => model.name)).toEqual([
      'gemma-iq3s',
      'strata-iq3s',
    ]);
    // Disposing (the window closing) must not leave anything running: the checks
    // are bounded by their own deadlines and by this abort.
    wiring2.dispose();
    second.subscriptions.forEach((disposable) => disposable.dispose());
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('a laptop with no remote_start entries is not noticed at all', async () => {
    desktop = await startFakeDesktop({ relayDown: true });
    fs.writeFileSync(configPath, 'active_model: x\nllama_server: {}\nmodels: []\n');
    const context = fakeContext();
    wireDesktopKeepingUp(context as never, {
      getConfig: () => YAML.parse(fs.readFileSync(configPath, 'utf8')) as never,
      getConfigPath: () => configPath,
      fetchImpl: fetch,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ui.info).toEqual([]);
    expect(desktop.starterRequests).toEqual([]);
  });

  // The workspace bootstrap wires this check into every window, including one
  // whose config is not fully parsed yet (a broken file, or a host that has not
  // read it). It must not throw out of activation, and it must not ask a desktop
  // that this config never dialled.
  it('a config that is not fully parsed gets no notice and makes no request', async () => {
    desktop = await startFakeDesktop({ relayDown: true });
    fs.writeFileSync(configPath, 'active_model: x\nllama_server: {}\n');
    const context = fakeContext();
    const logged = vi.spyOn(logger, 'info');
    const wiring = wireDesktopKeepingUp(context as never, {
      getConfig: () => YAML.parse(fs.readFileSync(configPath, 'utf8')) as never,
      getConfigPath: () => configPath,
      fetchImpl: fetch,
    });
    // Awaited, so a rejection out of the check fails here rather than showing up
    // as an unhandled error attached to some other test file: this is the proof
    // that a failure in an activation-time check cannot escape the window.
    await wiring.recheck();
    expect(ui.info).toEqual([]);
    expect(desktop.starterRequests).toEqual([]);
    // It is a clean no-op, not a reported failure: with the `models` guard in
    // place nothing is logged, so a laptop whose config has simply not been read
    // yet is not shown as a broken desktop. Remove that guard and this line goes
    // red, because the check then logs "Cannot read properties of undefined".
    expect(logged.mock.calls.filter((call) => String(call[0]).includes('keeping-up'))).toEqual([]);
    logged.mockRestore();
    expect(context.subscriptions).toHaveLength(1);
    wiring.dispose();
    context.subscriptions.forEach((disposable) => disposable.dispose());
  });

  // A palette command whose promise rejects is a silent failure: the owner
  // clicked, Forge said nothing, and the extension host swallowed the error. The
  // realistic way Connect throws is a `config.yaml` the owner edited badly
  // between the desktop read and the write, so that is the case under test — and
  // the file has to come out of it unchanged, because a refused write is not
  // permission to half-apply one.
  it('a command that cannot write says why, and leaves the file alone', async () => {
    desktop = await startFakeDesktop({ relayDown: true });
    const broken = 'active_model: x\nmodels: [\n  gemma-iq3s: {provider: ollama\n';
    fs.writeFileSync(configPath, broken);
    ui.handlers = {};
    const context = fakeContext();
    registerDesktopConnectCommands(context as never, {
      // The last config this window read: valid, and it dials the desktop. The
      // file on disk is what the owner has since edited into a syntax error.
      getConfig: () => YAML.parse(dialingConfig(desktop!.starterUrl, 'gemma-iq3s')) as never,
      getConfigPath: () => configPath,
      fetchImpl: fetch,
      relayPort: 1,
    });
    await ui.handlers[DESKTOP_CONNECT_COMMAND]!();
    expect(ui.errors).toHaveLength(1);
    expect(ui.errors[0]).toMatch(/config\.yaml parse failed/);
    expect(ui.info).toEqual([]);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(broken);
    // Reads only, even on the failure path: a command that failed to write must
    // not have started anything on the desktop to make up for it.
    expect(new Set(desktop.starterRequests)).toEqual(new Set(['GET /models']));
    context.subscriptions.forEach((disposable) => disposable.dispose());
  });

  // The same rule for the notice's button, where nothing at all awaits the
  // promise: an "Add them" that cannot write has to say so.
  it('"Add them" that cannot write says why instead of vanishing', async () => {
    desktop = await startFakeDesktop({ relayDown: true });
    const good = dialingConfig(desktop.starterUrl, 'gemma-iq3s');
    const broken = 'active_model: x\nmodels: [\n  gemma-iq3s: {provider: ollama\n';
    fs.writeFileSync(configPath, broken);
    ui.answer = 'Add them';
    const context = fakeContext();
    const wiring = wireDesktopKeepingUp(context as never, {
      getConfig: () => YAML.parse(good) as never,
      getConfigPath: () => configPath,
      fetchImpl: fetch,
      relayPort: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // One notice, then the reason the add could not be applied, and the owner's
    // file exactly as they left it.
    expect(ui.info.length).toBeGreaterThanOrEqual(1);
    expect(ui.errors).toHaveLength(1);
    expect(ui.errors[0]).toMatch(/config\.yaml parse failed/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(broken);
    expect(new Set(desktop.starterRequests)).toEqual(new Set(['GET /models']));
    wiring.dispose();
    context.subscriptions.forEach((disposable) => disposable.dispose());
  });
});
