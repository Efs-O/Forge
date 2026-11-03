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
import { MemorySecrets } from '../support/memorySecrets';
import type * as vscode from 'vscode';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig } from '../../src/config/types';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteHandoffCoordinator } from '../../src/remote/RemoteHandoffCoordinator';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { RemoteRuntime } from '../../src/remote/RemoteRuntime';
import { claimWorkspaceArrivals, createAnnounceGate } from '../../src/remote/remoteWorkspaceSwitch';
import { RemoteTransportLease } from '../../src/remote/RemoteTransportLease';
import { RemoteTransportManager } from '../../src/remote/RemoteTransportManager';
import { workspaceIdFor } from '../../src/remote/RemoteWorkspaceHandoff';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];

afterEach(async () => {
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
  mode: 'replace' | 'new-window' = 'replace',
): Promise<string> {
  const otherWindow = new RemoteRequestStore(statePath(directory));
  await otherWindow.load();
  return otherWindow.beginWorkspaceHandoff({
    channel: 'telegram',
    chatId: 'chat-a',
    sourceWorkspaceId: 'source-workspace',
    targetWorkspaceId,
    targetAlias: 'here',
    mode,
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

// Real timers and file polling: under a loaded full-suite run (the 2026-09-21
// audit validation) a 2 s deadline missed a handoff that did arrive. A lost
// handoff never arrives at all, so a longer deadline hides no race.
describe('workspace handoff between two live windows', { timeout: 30_000 }, () => {
  it('claims a chat handed to a window that is already running', async () => {
    const directory = await storageDirectory();
    const channel = new FakeRemoteChannel();
    const target = runtime(directory, channel);
    await target.applyConfig(config());

    await recordDepartureFromAnotherWindow(directory, 'workspace');

    await vi.waitFor(
      () =>
        expect(channel.sent.some((message) => message.text.startsWith('Forge: now in'))).toBe(true),
      { timeout: 10_000 },
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
    // The arrival receipt is sent on a later tick than the transport coming up
    // (takeOverTransports -> claim -> announce), so poll for it rather than
    // checking the array synchronously.
    await vi.waitFor(
      () =>
        expect(channel.sent.some((message) => message.text.startsWith('Forge: now in'))).toBe(true),
      { timeout: 10_000 },
    );
    await target.dispose();
  });

  /**
   * What the forced new window used to do: activate, find the lease held by the
   * window that already had that folder open, and sit in `takeOver` for 90 s —
   * holding everything after `setupRemoteRuntime` in `extension.ts` behind it,
   * and showing "Forge remote failed to start" for a switch that is working as
   * planned. The window's own watch owns that wait now, so activation comes
   * back in about 2 s, says nothing, and the chat is claimed once the lease
   * comes free.
   */
  it('does not wait on a contested lease at activation when a chat is coming', async () => {
    const directory = await storageDirectory();
    const channel = new FakeRemoteChannel();
    const notified: string[] = [];
    const heldByTheOtherWindow = await RemoteTransportLease.acquire({
      directory: path.join(directory, 'remote-leases'),
      key: 'telegram',
      workspaceId: 'source-workspace',
      instanceId: 'other-window',
      onLost: vi.fn(),
    });
    // The record first, so this window knows a chat is on its way before it
    // finds the lease taken — that is the case that used to be either silent
    // for 90 s or a toast about a switch that had not gone wrong.
    await recordDepartureFromAnotherWindow(directory, 'workspace', 'new-window');
    const target = runtime(directory, channel, {
      notifyLocal: (message) => notified.push(message),
    });
    const startedAt = Date.now();
    await target.applyConfig(config());
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(target.activeTransports()).toEqual([]);
    // Silent both ways: nothing went wrong here, and the window that has the
    // lease is the one answering this chat until the lease comes free.
    expect(notified).toEqual([]);
    expect(channel.sent.map((message) => message.text)).toEqual([]);
    await heldByTheOtherWindow.release();
    await vi.waitFor(() => expect(target.activeTransports()).toEqual(['telegram']), {
      timeout: 5_000,
    });
    await vi.waitFor(
      () =>
        expect(channel.sent.some((message) => message.text.startsWith('Forge: now in'))).toBe(true),
      { timeout: 10_000 },
    );
    expect(notified).toEqual([]);
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

    const finishSwitch = await source.switchWorkspace(applied, 'other', 'telegram', 'chat-a');
    await finishSwitch();
    expect(source.activeTransports()).toEqual([]);

    await vi.waitFor(
      () =>
        expect(channel.sent.some((message) => message.text.includes('could not switch'))).toBe(
          true,
        ),
      { timeout: 10_000 },
    );
    expect(source.activeTransports()).toEqual(['telegram']);
    const reader = new RemoteRequestStore(statePath(directory));
    await reader.load();
    expect(reader.hasPendingWorkspaceHandoff('workspace')).toBe(false);
    await source.dispose();
  });

  /**
   * The defect phase 2 exists to prevent: in `new-window` mode this window is
   * still alive, so an unclaimed switch has to put the phone back here —
   * transports up **and** the lease re-taken, because another window that is
   * still holding the lease is the one answering — and say which of the two
   * windows is serving.
   */
  it('a new-window switch nobody claims puts the phone back and says so', async () => {
    const directory = await storageDirectory();
    const channel = new FakeRemoteChannel();
    const elsewhere = await storageDirectory();
    const source = runtime(directory, channel, {
      // The second window opened; nothing reloaded this one, so the rollback
      // timer is the only thing that can answer the chat.
      openWorkspace: async () => undefined,
      workspaceRoot: elsewhere,
    });
    const applied = config(elsewhere);
    await source.applyConfig(applied);

    const finishSwitch = await source.switchWorkspace(
      applied,
      'other',
      'telegram',
      'chat-a',
      'new-window',
    );
    await finishSwitch();
    expect(source.activeTransports()).toEqual([]);

    await vi.waitFor(
      () =>
        expect(channel.sent.some((message) => message.text.includes('could not switch'))).toBe(
          true,
        ),
      { timeout: 10_000 },
    );
    // Transports up means the lease is held: no transport starts without it, so
    // this is the proof the phone is really answering here and not in the new
    // window that never claimed.
    expect(source.activeTransports()).toEqual(['telegram']);
    const undo = channel.sent.find((message) => message.text.includes('could not switch'))!;
    expect(undo.text).toContain('still open and answering');
    expect(undo.text).toContain('Other window is open too');
    await source.dispose();
  });

  it('a new-window arrival names the mode and the window still open', async () => {
    const directory = await storageDirectory();
    const channel = new FakeRemoteChannel();
    const target = runtime(directory, channel);
    await target.applyConfig(config());
    await recordDepartureFromAnotherWindow(directory, 'workspace', 'new-window');

    await vi.waitFor(
      () =>
        expect(channel.sent.some((message) => message.text.startsWith('Forge: now in'))).toBe(true),
      { timeout: 10_000 },
    );
    const arrival = channel.sent.find((message) => message.text.startsWith('Forge: now in'))!;
    // The owner cannot see which window is which from the phone: the receipt is
    // the only thing that says whether their old window is still there.
    expect(arrival.text).toContain('opened as a new window');
    expect(arrival.text).toContain('is still open');
    await target.dispose();
  });

  /**
   * Phase 3's first criterion, and the reason the plan names "come back into
   * service": the window that was serving the phone closed, its lease went
   * stale at the 20 s horizon, and this window — which has nothing handed to it
   * and no record of its own — takes the phone back with no reload. Before this
   * the only way back was a reload or a new switch, because `RemoteStartRetry`
   * has always answered a lease refusal with "another window serves this chat"
   * and never retried one, and the watch that does retry stops with the record.
   *
   * The lease is released rather than left to go stale, which is the same
   * contest: this window may not take it until the holder stops signing it.
   */
  it('comes back into service when the window that was serving closes', async () => {
    const directory = await storageDirectory();
    const channel = new FakeRemoteChannel();
    const notified: string[] = [];
    const hostFacade = host();
    const send = hostFacade.send as unknown as ReturnType<typeof vi.fn>;
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.telegram.ownerId', 'owner');
    // The prompt crosses as the fake channel's own name, because that is what
    // `RemoteQueueDrain` reads its queue by and what the auth gate checks; the
    // transport name only decides which lease and which receipt path.
    secrets.values.set('forge.remote.fake.ownerId', 'owner');
    const heldByTheServingWindow = await RemoteTransportLease.acquire({
      directory: path.join(directory, 'remote-leases'),
      key: 'telegram',
      workspaceId: 'source-workspace',
      instanceId: 'serving-window',
      onLost: vi.fn(),
    });
    // A chat bound to this workspace, written **before** this window starts, so
    // its copy of the shared state holds it when the prompt is admitted: written
    // afterwards, whether the answer reaches this conversation would depend on
    // when this window's coordinator poll happens to refresh, and a window that
    // came back with no binding still answers — into a brand-new conversation,
    // which is what the last assertion rules out. The binding is shared state,
    // not this window's memory, and that is the point of coming back: the window
    // that takes the phone has somewhere to send the answer.
    const writer = new RemoteRequestStore(statePath(directory));
    await writer.load();
    await writer.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    const waiting = runtime(directory, channel, {
      notifyLocal: (message) => notified.push(message),
      host: hostFacade,
      secrets: secrets as unknown as vscode.SecretStorage,
    });
    await expect(waiting.applyConfig(config())).rejects.toThrow(/already owned/);
    expect(waiting.activeTransports()).toEqual([]);
    // Silent while it waits: nothing is wrong with this window, and the phone
    // is answering next door. A toast every tick is the log spam phase 3 has to
    // avoid, not a report to put on the owner's screen.
    expect(notified).toEqual([]);

    await heldByTheServingWindow.release();
    // 10 s, not 5: the come-back is one tick, one slot on the lifecycle chain,
    // one shared-state write and one lease file, and under a loaded full-suite
    // run every one of those is slower than it looks. The assertion is unchanged
    // — this window takes the phone with nobody reloading it.
    await vi.waitFor(() => expect(waiting.activeTransports()).toEqual(['telegram']), {
      timeout: 10_000,
    });
    const disposition = await channel.emit({
      channel: 'fake',
      kind: 'text',
      providerMessageId: 'prompt-after-come-back',
      senderId: 'owner',
      chatId: 'chat-a',
      chatType: 'private',
      receivedAt: Date.now(),
      text: 'are you back?',
    });
    // Admitted, not refused: this window is the one serving the phone now, and
    // the chat is bound to its workspace.
    expect(disposition.kind).toBe('accepted');
    await vi.waitFor(
      () =>
        expect(send).toHaveBeenCalledWith(
          'c1',
          'are you back?',
          undefined,
          expect.objectContaining({ remoteRequestId: expect.any(String) }),
        ),
      { timeout: 10_000 },
    );
    expect(notified).toEqual([]);
    // Routed to the conversation the shared state already names, not a new one:
    // a window that came back and answered into a fresh conversation would have
    // quietly lost this chat's history, and the owner could not tell from the
    // phone that it had happened.
    expect(hostFacade.createConversation).not.toHaveBeenCalled();
    await waiting.dispose();
  });

  /**
   * The other half of the same criterion: a window whose lease is live
   * elsewhere must not *flap*. It is not serving and it is not wrong, so it
   * ticks forever — and a tick that started transports, failed and stopped
   * them again would churn the lease every five seconds, spam the log, and
   * could steal the lease from a window that is answering right now.
   */
  it('a window whose lease is live elsewhere does not flap', async () => {
    const directory = await storageDirectory();
    const channel = new FakeRemoteChannel();
    const notified: string[] = [];
    let startsAttempted = 0;
    const heldByTheServingWindow = await RemoteTransportLease.acquire({
      directory: path.join(directory, 'remote-leases'),
      key: 'telegram',
      workspaceId: 'source-workspace',
      instanceId: 'serving-window',
      onLost: vi.fn(),
    });
    const waiting = runtime(directory, channel, {
      notifyLocal: (message) => notified.push(message),
      // Counted, because a transport factory is only reached after the lease is
      // won: every call here would be a window that started and stopped.
      channelFactories: {
        telegram: async () => {
          startsAttempted += 1;
          return channel;
        },
      },
    });
    await expect(waiting.applyConfig(config())).rejects.toThrow(/already owned/);
    // The shared state as it stands once this window's own activation write has
    // settled. `RemoteTransportManager.startTransport` reconciles dead claims in
    // `remote-state-v2.json` **before** it tries the lease, so a come-back that
    // attempted anyway would rewrite the shared file every tick forever — and
    // every other window's coordinator poll is gated on that file's modified
    // time, so each of them would re-read the whole state every tick too.
    const stateFile = statePath(directory);
    const stateBefore = await fs.stat(stateFile);
    const bytesBefore = await fs.readFile(stateFile, 'utf8');
    // Many ticks of the window's own watch, with the lease still held next
    // door: 1.2 s against a 20 ms tick is dozens of attempts.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(waiting.activeTransports()).toEqual([]);
    expect(startsAttempted).toBe(0);
    expect(notified).toEqual([]);
    expect(channel.sent.map((message) => message.text)).toEqual([]);
    // Zero writes, which is the defect this guards: the come-back peeks at the
    // lease first and returns while a live window is signing it. Bytes alone
    // would pass a rewrite that pruned nothing, so the modified time — the thing
    // the other windows' polls read — is checked beside them.
    const stateAfter = await fs.stat(stateFile);
    expect(await fs.readFile(stateFile, 'utf8')).toBe(bytesBefore);
    expect(stateAfter.mtimeMs).toBe(stateBefore.mtimeMs);
    // The lease is still the serving window's, byte for byte: a window that
    // cannot have it must not reclaim it, which would cut off a chat that is
    // being answered on the phone.
    const lease = JSON.parse(
      await fs.readFile(path.join(directory, 'remote-leases', 'telegram.lease.json'), 'utf8'),
    ) as { instanceId: string };
    expect(lease.instanceId).toBe('serving-window');
    await heldByTheServingWindow.release();
    await waiting.dispose();
  });

  /**
   * The come-back has to leave the phone free for the window it asked for, or
   * this feature breaks the switch it exists beside: the window that ran
   * `new-window` stopped its transports and released the lease **on purpose**,
   * and the plan gives the target window `NEW_WINDOW_ROLLBACK_MS` to activate
   * and claim (73 s open→activation measured in phase 0, and the lease is
   * released before the folder is even opened). An ungated come-back takes the
   * free lease about one tick after the switch, the target then finds a live
   * lease next door and never gets the phone, and the rollback fires for a move
   * that would have worked — "could not switch", for nothing.
   */
  it('leaves the phone free for the window it asked to be opened', async () => {
    const directory = await storageDirectory();
    const channel = new FakeRemoteChannel();
    const elsewhere = await storageDirectory();
    const source = runtime(directory, channel, {
      // What `vscode.openFolder` does in `new-window` mode here: the second
      // window is opened somewhere else and this one keeps running.
      openWorkspace: async () => undefined,
      workspaceRoot: elsewhere,
      // Production rollback timing: 90 s for `new-window`, so during the wait
      // this window's own watch is the only thing that could answer.
      handoffWatch: { pollIntervalMs: 20 },
    });
    const applied = config(elsewhere);
    await source.applyConfig(applied);

    const finishSwitch = await source.switchWorkspace(
      applied,
      'other',
      'telegram',
      'chat-a',
      'new-window',
    );
    await finishSwitch();
    expect(source.activeTransports()).toEqual([]);

    // Dozens of this window's own 20 ms ticks pass with the lease free and
    // nobody serving: the target is still starting, and this window may not
    // take the phone back while it is waiting for that window to claim.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(source.activeTransports()).toEqual([]);
    expect(channel.sent.map((message) => message.text)).toEqual([]);

    // The cold target arrives late, as a real one does, and gets its whole
    // claim window: lease, chat, receipt.
    const target = runtime(directory, channel, {
      workspaceId: workspaceIdFor(elsewhere),
      handoffWatch: { pollIntervalMs: 20, rollbackDelayMs: 40 },
    });
    await target.applyConfig(config());
    await vi.waitFor(() => expect(target.activeTransports()).toEqual(['telegram']), {
      timeout: 5_000,
    });
    await vi.waitFor(
      () =>
        expect(channel.sent.some((message) => message.text.startsWith('Forge: now in'))).toBe(
          true,
        ),
      { timeout: 10_000 },
    );
    // The switch completed, so the source stays out of service and says
    // nothing: it is the window that moved away, not the one answering.
    expect(source.activeTransports()).toEqual([]);
    expect(channel.sent.map((message) => message.text).some((text) => text.includes('could not switch'))).toBe(
      false,
    );
    await target.dispose();
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
    await store.claimAndBindWorkspaceHandoff(handoffId, 'target-workspace');
    const takeTransports = vi.fn(async () => true);
    const releaseTransports = vi.fn(async () => undefined);
    const sendToChat = vi.fn(async () => undefined);
    const coordinator = new RemoteHandoffCoordinator({
      store,
      storePath: statePath(directory),
      workspaceId: 'source-workspace',
      serialize: (task) => task(),
      claimArrivals: async () => undefined,
      takeTransports,
      releaseTransports,
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

    // It took the lease to ask, and must give it back: the window that claimed
    // the chat needs it to serve, and a rollback that keeps it would leave the
    // phone answering in a window that has no claim on the chat.
    expect(takeTransports).toHaveBeenCalledTimes(1);
    expect(releaseTransports).toHaveBeenCalledTimes(1);
    expect(sendToChat).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('a rollback that cannot take the lease leaves the record alone and says nothing', async () => {
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
    const takeTransports = vi.fn(async () => false);
    const releaseTransports = vi.fn(async () => undefined);
    const sendToChat = vi.fn(async () => undefined);
    const coordinator = new RemoteHandoffCoordinator({
      store,
      storePath: statePath(directory),
      workspaceId: 'source-workspace',
      serialize: (task) => task(),
      claimArrivals: async () => undefined,
      takeTransports,
      releaseTransports,
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

    // A third window holds the lease and is serving this chat: stealing it
    // would cut off a chat that is answering, and saying "you are still here"
    // would be a lie. The record is left for whoever holds the lease to claim.
    expect(store.peekWorkspaceHandoffs('target-workspace')).toHaveLength(1);
    expect(sendToChat).not.toHaveBeenCalled();
    expect(releaseTransports).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('a cold target that starts after the rollback fired claims nothing', async () => {
    const directory = await storageDirectory();
    const source = new RemoteRequestStore(statePath(directory));
    await source.load();
    const handoffId = await source.beginWorkspaceHandoff({
      channel: 'telegram',
      chatId: 'chat-a',
      sourceWorkspaceId: 'source-workspace',
      targetWorkspaceId: 'target-workspace',
      targetAlias: 'other',
    });
    const sendToChat = vi.fn(async () => undefined);
    const coordinator = new RemoteHandoffCoordinator({
      store: source,
      storePath: statePath(directory),
      workspaceId: 'source-workspace',
      serialize: (task) => task(),
      claimArrivals: async () => undefined,
      takeTransports: async () => true,
      releaseTransports: async () => undefined,
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
    expect(sendToChat).toHaveBeenCalledTimes(1);

    // The window that was still starting now finds the record failed, not
    // pending: claiming it would contradict the "you are still here" the source
    // has already sent, and would land the chat in a window with no lease.
    const late = new RemoteRequestStore(statePath(directory));
    await late.load();
    expect(late.peekWorkspaceHandoffs('target-workspace')).toHaveLength(0);
    expect((await late.claimAndBindWorkspaceHandoff(handoffId, 'target-workspace')).ok).toBe(false);
    coordinator.dispose();
  });

  /**
   * A binding write that throws leaves the record pending, so this window's own
   * watch re-attempts the claim every tick. The receipt for that failure has to
   * be said once: a chat told "could not be bound here, send /workspace again"
   * every five seconds until the record's TTL would be told to repeat itself
   * hundreds of times.
   */
  it('says the binding failure once across the retry ticks', async () => {
    const directory = await storageDirectory();
    const store = new RemoteRequestStore(statePath(directory));
    await store.load();
    await store.beginWorkspaceHandoff({
      channel: 'telegram',
      chatId: 'chat-a',
      sourceWorkspaceId: 'source-workspace',
      targetWorkspaceId: 'workspace',
      targetAlias: 'here',
    });
    const channel = new FakeRemoteChannel();
    const deps = {
      store,
      // The lease is already ours in this fixture: `takeOver` returning at once
      // is what a window that holds it does.
      manager: {
        takeOver: async () => undefined,
        get: () => ({ channel }),
      } as unknown as RemoteTransportManager,
      coordinator: {} as RemoteHandoffCoordinator,
      workspaceId: 'workspace',
      host: host(),
      isDisposed: () => false,
      requestedConfig: () => config(),
      activeTransports: () => ['telegram'],
      announceOnce: createAnnounceGate(),
      totpEnrolled: async () => false,
      notifyLocal: vi.fn(),
      stopTransports: async () => undefined,
    } as unknown as Parameters<typeof claimWorkspaceArrivals>[0];
    // Every attempt fails the same way, which is what a contended state lock
    // does to the one write that claims, binds and completes.
    (
      store as unknown as { claimAndBindWorkspaceHandoff: () => Promise<never> }
    ).claimAndBindWorkspaceHandoff = async () => {
      throw new Error('Forge remote state lock timed out');
    };

    await claimWorkspaceArrivals(deps);
    await claimWorkspaceArrivals(deps);
    await claimWorkspaceArrivals(deps);

    expect(
      channel.sent.filter((message) => message.text.includes('could not be bound here')),
    ).toHaveLength(1);
    expect(
      channel.sent.filter((message) => message.text.includes('send /workspace here again')),
    ).toHaveLength(1);
  });

  it("keeps the target window's claim through the source window's later writes", async () => {
    const directory = await storageDirectory();
    const source = new RemoteRequestStore(statePath(directory));
    const target = new RemoteRequestStore(statePath(directory));
    await source.load();
    await target.load();
    const handoffId = await source.beginWorkspaceHandoff({
      channel: 'telegram',
      chatId: 'chat-a',
      sourceWorkspaceId: 'source-workspace',
      targetWorkspaceId: 'target-workspace',
      targetAlias: 'other',
    });
    expect((await target.claimAndBindWorkspaceHandoff(handoffId, 'target-workspace')).ok).toBe(
      true,
    );
    // The polling cursor is saved on every poll; it must not write back the
    // source window's stale copy over the claim.
    await source.setCursor('telegram', '42');
    expect(await source.failUnclaimedWorkspaceHandoff(handoffId)).toBe('claimed');
  });
});
