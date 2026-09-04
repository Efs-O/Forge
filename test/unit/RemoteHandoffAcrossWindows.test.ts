/**
 * The failure these cover: `/new <workspace>` recorded the handoff, stopped the
 * transports and called `openFolder` — which focused the window that already
 * had that folder open instead of reloading this one. Nothing reloaded, so the
 * activation-time claim never ran, and the lease had already been released. No
 * window served the chat and it went silent after "switching…".
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig } from '../../src/config/types';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteHandoffCoordinator } from '../../src/remote/RemoteHandoffCoordinator';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { RemoteRuntime } from '../../src/remote/RemoteRuntime';
import { RemoteTransportLease } from '../../src/remote/RemoteTransportLease';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

class MemorySecrets {
  readonly values = new Map<string, string>();
  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  store(key: string, value: string): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Thenable<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
  onDidChange = vi.fn();
}

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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-handoff-'));
  tempDirs.push(directory);
  return directory;
}

function statePath(directory: string): string {
  return path.join(directory, 'remote-state-v2.json');
}

function config(aliasPath?: string): ForgeConfig {
  return ForgeConfigSchema.parse({
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    remote: {
      enabled: true,
      telegram: { enabled: true },
      ...(aliasPath
        ? { workspace_aliases: { other: { path: aliasPath, display_name: 'Other' } } }
        : {}),
    },
  });
}

/** Stands in for the window that ran `/new`: a separate store over the same
 *  global-storage file, which is all another VS Code window is here. */
async function recordDepartureFromAnotherWindow(
  directory: string,
  targetWorkspaceId: string,
): Promise<string> {
  const otherWindow = new RemoteRequestStore(statePath(directory));
  await otherWindow.load();
  return otherWindow.beginWorkspaceHandoff({
    channel: 'telegram',
    chatId: 'chat-a',
    sourceWorkspaceId: 'source-workspace',
    targetWorkspaceId,
    targetAlias: 'here',
  });
}

function runtime(
  directory: string,
  channel: FakeRemoteChannel,
  overrides: Partial<ConstructorParameters<typeof RemoteRuntime>[0]> = {},
): RemoteRuntime {
  const secrets = new MemorySecrets();
  secrets.values.set('forge.remote.telegram.ownerId', 'owner');
  return new RemoteRuntime({
    storageDirectory: directory,
    workspaceId: 'workspace',
    host: host(),
    secrets: secrets as unknown as vscode.SecretStorage,
    channelFactories: { telegram: () => channel },
    notifyLocal: vi.fn(),
    handoffWatch: { pollIntervalMs: 20, rollbackDelayMs: 40 },
    ...overrides,
  });
}

describe('workspace handoff between two live windows', () => {
  it('claims a chat handed to a window that is already running', async () => {
    const directory = await storageDirectory();
    const channel = new FakeRemoteChannel();
    const target = runtime(directory, channel);
    await target.applyConfig(config());

    await recordDepartureFromAnotherWindow(directory, 'workspace');

    await vi.waitFor(
      () =>
        expect(channel.sent.some((message) => message.text.startsWith('Forge: now in'))).toBe(true),
      { timeout: 2_000 },
    );
    const reader = new RemoteRequestStore(statePath(directory));
    await reader.load();
    expect(reader.binding('telegram', 'chat-a')?.workspaceId).toBe('workspace');
    expect(reader.hasPendingWorkspaceHandoff('workspace')).toBe(false);
    await target.dispose();
  });

  it('takes the transport over when the switch releases the lease', async () => {
    const directory = await storageDirectory();
    const channel = new FakeRemoteChannel();
    // The window being left still owns the transport, so this one cannot
    // start: the case that used to leave the runtime with no config to start
    // from and no watch running.
    const heldByTheOtherWindow = await RemoteTransportLease.acquire({
      directory: path.join(directory, 'remote-leases'),
      key: 'telegram',
      workspaceId: 'source-workspace',
      instanceId: 'other-window',
      onLost: vi.fn(),
    });
    const target = runtime(directory, channel);
    await expect(target.applyConfig(config())).rejects.toThrow(/already owned/);
    expect(target.activeTransports()).toEqual([]);

    await recordDepartureFromAnotherWindow(directory, 'workspace');
    await heldByTheOtherWindow.release();

    await vi.waitFor(() => expect(target.activeTransports()).toEqual(['telegram']), {
      timeout: 5_000,
    });
    expect(channel.sent.some((message) => message.text.startsWith('Forge: now in'))).toBe(true);
    await target.dispose();
  });

  it('takes the chat back when opening the target folder does not reload', async () => {
    const directory = await storageDirectory();
    const channel = new FakeRemoteChannel();
    const elsewhere = await storageDirectory();
    const source = runtime(directory, channel, {
      // What `vscode.openFolder` does when that folder is already open in
      // another window: it resolves, and this window keeps running.
      openWorkspace: async () => undefined,
      workspaceRoot: elsewhere,
    });
    const applied = config(elsewhere);
    await source.applyConfig(applied);

    await source.switchWorkspace(applied, 'other', 'telegram', 'chat-a');
    expect(source.activeTransports()).toEqual([]);

    await vi.waitFor(
      () =>
        expect(channel.sent.some((message) => message.text.includes('could not switch'))).toBe(
          true,
        ),
      { timeout: 2_000 },
    );
    expect(source.activeTransports()).toEqual(['telegram']);
    const reader = new RemoteRequestStore(statePath(directory));
    await reader.load();
    expect(reader.hasPendingWorkspaceHandoff('workspace')).toBe(false);
    await source.dispose();
  });
});

describe('handoff rollback', () => {
  it('leaves a claimed handoff alone rather than contradicting the window that took it', async () => {
    const directory = await storageDirectory();
    const store = new RemoteRequestStore(statePath(directory));
    await store.load();
    const handoffId = await store.beginWorkspaceHandoff({
      channel: 'telegram',
      chatId: 'chat-a',
      sourceWorkspaceId: 'source-workspace',
      targetWorkspaceId: 'target-workspace',
      targetAlias: 'other',
    });
    await store.claimWorkspaceHandoffs('target-workspace');
    const restoreTransports = vi.fn(async () => undefined);
    const sendToChat = vi.fn(async () => undefined);
    const coordinator = new RemoteHandoffCoordinator({
      store,
      storePath: statePath(directory),
      workspaceId: 'source-workspace',
      serialize: (task) => task(),
      claimArrivals: async () => undefined,
      restoreTransports,
      sendToChat,
      notifyLocal: vi.fn(),
    });

    await coordinator.rollbackNow({
      handoffId,
      channel: 'telegram',
      chatId: 'chat-a',
      targetName: 'Other',
      currentName: 'Here',
    });

    expect(restoreTransports).not.toHaveBeenCalled();
    expect(sendToChat).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});
