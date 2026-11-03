/**
 * The failure these cover: a VS Code Remote window (the laptop) used to run the
 * desktop's own jobs alongside it. It started Telegram there — a 409 against the
 * bot the desktop window is already polling, plus a "no bot token" toast,
 * because a remote window's SecretStorage is the machine being typed on, which
 * holds no keys by owner rule — it created a transport lease and a
 * `remote-state-v2.json` in the remote window's own global storage, and it could
 * win the bind race for the model starter (8798) and the cloud relay (8797),
 * serving them from a window that holds no keys at all.
 *
 * This is the CI-enforceable row of `docs/plans/LAPTOP_HEAD_PLAN.md`'s
 * state × lifecycle ledger: a later change that makes a remote window create or
 * bind a new remote-side artifact fails here.
 *
 * A WSL, Dev Container, attached-container or Codespaces window is NOT that
 * window: its extension host runs on the machine being typed on (or in a VM
 * with no second Forge window), and VS Code stores secrets on the client, so
 * its keychain does hold the keys and there may be no other window here to
 * hand anything to. `remoteWindowKind.ts` owns that decision; the tables below
 * assert both sides of it — the hosted kinds run and bind nothing, the others
 * run and bind everything a local window does.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemorySecrets } from '../support/memorySecrets';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig } from '../../src/config/types';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteRuntime } from '../../src/remote/RemoteRuntime';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import { startWakeRelay } from '../../src/vscode/wakeRelaySetup';
import { wireTailnetServices } from '../../src/vscode/tailnetServicesSetup';
import {
  remoteKindHostsElsewhere,
  thisWindowHostedElsewhere,
} from '../../src/vscode/remoteWindowKind';

const mocks = vi.hoisted(() => ({
  wireModelStarter: vi.fn(() => ({ applyConfig: () => undefined, dispose: () => undefined })),
  wireCloudRelay: vi.fn(() => ({ applyConfig: () => undefined, dispose: () => undefined })),
}));

// The two services are the only binders of 8797 and 8798, so "wires neither" is
// exactly "binds neither": no listener is ever created.
vi.mock('../../src/backend/ModelStarterServer', () => ({
  wireModelStarter: mocks.wireModelStarter,
}));
vi.mock('../../src/llm/CloudRelayServer', () => ({
  wireCloudRelay: mocks.wireCloudRelay,
}));

/** `vscode.env` is read-only in @types/vscode; the test alias is a plain object. */
const env = vscode.env as { remoteName?: string };

const tempDirs: string[] = [];

afterEach(async () => {
  env.remoteName = undefined;
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function host(): ForgeHostFacade {
  let created = 0;
  return {
    createConversation: vi.fn(async () => ({
      id: `c${(created += 1)}`,
      title: 'Remote',
      activeModel: 'local',
      archived: false,
    })),
    restoreConversation: vi.fn(),
    send: vi.fn(async () => ({ kind: 'completed' as const, finalText: 'done' })),
    cancel: vi.fn(async () => undefined),
    queueIntent: vi.fn(),
    resolveApproval: vi.fn(),
    addApprovalSink: () => ({ dispose: () => undefined }),
    addQuestionSink: () => ({ dispose: () => undefined }),
    answerQuestion: () => false,
    status: () => ({
      activeConversationId: 'visible',
      conversations: [],
      requestChains: [],
      streamingConversationIds: [],
    }),
    clankerMode: vi.fn(() => false),
    setClankerMode: vi.fn(),
    contextBudget: vi.fn(() => ({ used: 1000, max: 4000 })),
    compact: vi.fn(async () => 'compacted' as const),
  } as unknown as ForgeHostFacade;
}

async function storageDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-window-guard-'));
  tempDirs.push(directory);
  return directory;
}

async function exists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(
      () => true,
      () => false,
    );
}

function config(): ForgeConfig {
  return ForgeConfigSchema.parse({
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    remote: { enabled: true, telegram: { enabled: true } },
  });
}

/** `remote.wake_relay.enabled` needs host/port/relay_ip. Each window kind gets
 *  its own port, so a close still in flight from the previous variant cannot
 *  hand this one EADDRINUSE; 45999 and up are nobody's. */
let nextWakeRelayPort = 45998;
function wakeRelayConfig(): ForgeConfig {
  return ForgeConfigSchema.parse({
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    remote: {
      enabled: true,
      wake_relay: {
        enabled: true,
        host: '127.0.0.1',
        port: (nextWakeRelayPort += 1),
        relay_ip: '127.0.0.1',
      },
    },
  });
}

function fakeContext(): { subscriptions: Array<{ dispose(): void }> } {
  return { subscriptions: [] };
}

/**
 * Runs `startWakeRelay` for a window of `kind` and reports what it did: how
 * many disposables it pushed and how many toasts it showed. The reason is
 * logged by `remoteRuntimeSetup`, so a hosted window's relay must bind nothing
 * AND say nothing; a window that is not hosted must bind the port like a local
 * window and still show no error.
 */
async function wakeRelayRunFor(kind: string | undefined): Promise<{ pushed: number; toasts: number }> {
  env.remoteName = kind;
  const errors = vi.spyOn(vscode.window, 'showErrorMessage');
  const context = fakeContext();
  await startWakeRelay(
    context as unknown as vscode.ExtensionContext,
    wakeRelayConfig(),
    undefined as unknown as ForgeHostFacade,
  );
  const { length: pushed } = context.subscriptions;
  const toasts = errors.mock.calls.length;
  for (const subscription of context.subscriptions.splice(0)) subscription.dispose();
  return { pushed, toasts };
}

/**
 * Runs `wireTailnetServices` for a window of `kind` and returns how many times
 * each service was wired. The two are the only binders of 8797 and 8798, so
 * "wires neither" is exactly "binds neither": no listener is ever created.
 */
function tailnetRunFor(kind: string | undefined): { starter: number; relay: number } {
  env.remoteName = kind;
  mocks.wireModelStarter.mockClear();
  mocks.wireCloudRelay.mockClear();
  const context = fakeContext();
  const wiring = wireTailnetServices(
    context as unknown as vscode.ExtensionContext,
    () => config(),
    undefined as never,
    undefined as never,
    undefined as never,
  );
  wiring.applyConfig();
  wiring.dispose();
  return {
    starter: mocks.wireModelStarter.mock.calls.length,
    relay: mocks.wireCloudRelay.mock.calls.length,
  };
}

/**
 * `vscode.env.remoteName` is set for EVERY remote kind, so a guard that fires
 * on all of them takes Telegram, the wake relay, the starter, the cloud relay
 * and the keyed cloud models away from WSL and container users, whose keychain
 * IS this computer's. Only `tunnel` and `ssh-remote` mean a second computer is
 * typing at another machine's own Forge window. This is the decision
 * `remoteWindowKind.ts` owns, and every wiring test below runs both sides of
 * it, so a change that re-widens the guard fails here rather than shipping.
 */
describe('which remote kinds mean this window is hosted elsewhere', () => {
  it.each(['tunnel', 'ssh-remote'])('%s: another computer is typing at a Forge window', (kind) => {
    expect(remoteKindHostsElsewhere(kind)).toBe(true);
    env.remoteName = kind;
    expect(thisWindowHostedElsewhere()).toBe(true);
  });

  it.each([undefined, 'wsl', 'dev-container', 'attached-container', 'codespaces'])(
    '%s: this computer, so nothing is handed off',
    (kind) => {
      expect(remoteKindHostsElsewhere(kind)).toBe(false);
      env.remoteName = kind;
      expect(thisWindowHostedElsewhere()).toBe(false);
    },
  );
});

const HOSTED_ELSEWHERE =
  "Telegram, WhatsApp and the wake relay run in the desktop's own Forge window, " +
  'not in this VS Code Remote window.';

describe('a VS Code Remote window runs no transports', () => {
  it('starts nothing, writes nothing, and says why when asked to pair', async () => {
    const directory = await storageDirectory();
    const channel = new FakeRemoteChannel('telegram');
    const factory = vi.fn(async () => channel);
    const runtime = new RemoteRuntime({
      storageDirectory: directory,
      workspaceId: 'workspace',
      host: host(),
      secrets: new MemorySecrets() as unknown as vscode.SecretStorage,
      channelFactories: { telegram: factory },
      notifyLocal: vi.fn(),
      hostedElsewhere: HOSTED_ELSEWHERE,
    });

    await runtime.applyConfig(config());
    // The command that recreates a transport after a token change: in a remote
    // window that token went into the laptop's keychain, so there is nothing
    // here to rebuild.
    await runtime.refreshTransport('telegram', config());

    expect(factory).not.toHaveBeenCalled();
    expect(await exists(path.join(directory, 'remote-leases'))).toBe(false);
    expect(await exists(path.join(directory, 'remote-state-v2.json'))).toBe(false);
    expect(await runtime.status()).toEqual({ transports: [], paired: false });
    // Nothing pins a chat in this window, so the eviction gate must not claim
    // an "unreachable remote runtime" for every chat it holds.
    expect(runtime.blocksConversationEviction('c1')).toBe(false);
    expect(() => runtime.beginPairing('telegram')).toThrow(HOSTED_ELSEWHERE);
    await runtime.dispose();
  });

  it('starts the transport when nothing else hosts it, so the test above is not vacuous', async () => {
    const directory = await storageDirectory();
    const channel = new FakeRemoteChannel('telegram');
    const factory = vi.fn(async () => channel);
    const runtime = new RemoteRuntime({
      storageDirectory: directory,
      workspaceId: 'workspace',
      host: host(),
      secrets: new MemorySecrets() as unknown as vscode.SecretStorage,
      channelFactories: { telegram: factory },
      notifyLocal: vi.fn(),
    });

    // A WSL, container or Codespaces window lands here too: `remoteWindowKind.ts`
    // counts it as this computer's own, so `remoteRuntimeSetup` gives this
    // runtime no reason to stand down.
    await runtime.applyConfig(config());

    expect(factory).toHaveBeenCalled();
    expect(await exists(path.join(directory, 'remote-leases'))).toBe(true);
    expect(await exists(path.join(directory, 'remote-state-v2.json'))).toBe(true);
    expect(await runtime.status()).toEqual({ transports: ['telegram'], paired: false });
    await runtime.dispose();
  });
});

describe('a window hosted elsewhere binds neither the wake relay nor the tailnet services', () => {
  it.each(['tunnel', 'ssh-remote'])('%s: startWakeRelay pushes nothing and shows no error', async (kind) => {
    expect(await wakeRelayRunFor(kind)).toEqual({ pushed: 0, toasts: 0 });
  });

  it.each(['wsl', 'dev-container'])('%s: the wake relay starts as it does locally', async (kind) => {
    const run = await wakeRelayRunFor(kind);
    expect(run.pushed).toBe(1);
    expect(run.toasts).toBe(0);
  });

  it('a local window still starts it, so the guard above is not vacuous', async () => {
    expect((await wakeRelayRunFor(undefined)).pushed).toBe(1);
  });

  it.each(['tunnel', 'ssh-remote'])('%s: wireTailnetServices wires neither service', (kind) => {
    expect(tailnetRunFor(kind)).toEqual({ starter: 0, relay: 0 });
  });

  it.each(['wsl', 'dev-container'])('%s: the starter and the cloud relay wire as locally', (kind) => {
    expect(tailnetRunFor(kind)).toEqual({ starter: 1, relay: 1 });
  });

  it('a local window wires both, so that guard is not vacuous either', () => {
    expect(tailnetRunFor(undefined)).toEqual({ starter: 1, relay: 1 });
  });
});

describe('the setting that names the config file', () => {
  // `forge.configFile` was `application`-scoped, which is what made the two
  // machines disagree about which config to load: a remote window read the
  // setting from the machine being typed on, never from the Remote settings of
  // the one being worked on, and the same value in the laptop's User settings
  // then pointed every laptop-local window at the desktop's file. `machine`
  // scope is what makes them independent. Asserted here because no other
  // package.json contract test reads `contributes.configuration`.
  it('is machine-scoped and says where a remote window sets it', async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.resolve('package.json'), 'utf8'),
    ) as {
      contributes: {
        configuration: { properties: Record<string, { scope?: string; description?: string }> };
      };
    };
    const setting = manifest.contributes.configuration.properties['forge.configFile'];
    expect(setting.scope).toBe('machine');
    expect(setting.description).toContain('Per computer');
    expect(setting.description).toContain('In a VS Code Remote window, set it in Remote settings');
  });
});
