import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import type { RemoteAuth } from '../../src/remote/RemoteAuth';
import {
  buildRemoteRuntimeHandoff,
  type RemoteRuntimeHandoffInput,
} from '../../src/remote/remoteRuntimeHandoffWiring';
import type { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RemoteTransportManager } from '../../src/remote/RemoteTransportManager';
import type { RemoteRuntimeOptions } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

/**
 * The workspace-handoff wiring `RemoteRuntime` used to build inside its own
 * constructor. The thirteen runtime tests already drive it end-to-end; these
 * pin the moved bundle directly, because a wiring move is only safe while the
 * bundle keeps reading the runtime **live** — a value copied at build time
 * would type-check, pass every runtime test, and then watch a window that had
 * already been handed a chat.
 */

const host = {} as ForgeHostFacade;

function harness(optionOverrides: Partial<RemoteRuntimeOptions> = {}) {
  const names = ['telegram'];
  const stopActive = vi.fn(async () => undefined);
  const manager = {
    names: () => names,
    stopActive,
    get: vi.fn(() => undefined),
  } as unknown as RemoteTransportManager;
  const totpEnrolled = vi.fn(async () => true);
  const auth = { totpEnrolled } as unknown as RemoteAuth;
  const store = { which: 'store' } as unknown as RemoteRequestStore;
  const options: RemoteRuntimeOptions = {
    storageDirectory: '/global-storage',
    workspaceId: 'ws-1',
    host,
    secrets: {
      get: vi.fn(),
      store: vi.fn(),
      delete: vi.fn(),
      onDidChange: vi.fn(),
    } as unknown as vscode.SecretStorage,
    notifyLocal: vi.fn(),
    ...optionOverrides,
  };
  // The runtime's own lifecycle chain, passed as a callback.
  const serialize: RemoteRuntimeHandoffInput['serialize'] = <Task>(task: () => Promise<Task>) =>
    task();
  let disposed = false;
  let config: ForgeConfig | undefined;
  const isDisposed = (): boolean => disposed;
  const requestedConfig = (): ForgeConfig | undefined => config;
  const input: RemoteRuntimeHandoffInput = {
    options,
    storePath: '/global-storage/remote-state-v2.json',
    store,
    manager,
    auth,
    serialize,
    isDisposed,
    requestedConfig,
  };
  return {
    input,
    options,
    store,
    manager,
    auth,
    names,
    stopActive,
    totpEnrolled,
    setDisposed: (value: boolean) => {
      disposed = value;
    },
    setConfig: (value: ForgeConfig | undefined) => {
      config = value;
    },
  };
}

describe('buildRemoteRuntimeHandoff', () => {
  it('hands back the three objects the runtime stores, over the same collaborators', () => {
    const { input, store, manager } = harness();
    const bundle = buildRemoteRuntimeHandoff(input);
    expect(bundle.handoff.store).toBe(store);
    expect(bundle.handoff.manager).toBe(manager);
    expect(bundle.coordinator).toBe(bundle.handoff.coordinator);
    expect(bundle.handoff.workspaceId).toBe('ws-1');
    expect(bundle.handoff.host).toBe(host);
    expect(bundle.handoff.globalStoragePath).toBe('/global-storage');
    expect(typeof bundle.coordinator.watch).toBe('function');
    expect(typeof bundle.windowWatch.start).toBe('function');
    expect(typeof bundle.windowWatch.dispose).toBe('function');
  });

  it('omits the optional window fields the runtime was not given, as absent keys', () => {
    const bundle = buildRemoteRuntimeHandoff(harness().input);
    // Not `undefined` either: the bundle is built with the spread idiom, and a
    // present-but-undefined key would make a window look like it can close
    // itself when nobody passed it the way to do that.
    expect('workspaceRoot' in bundle.handoff).toBe(false);
    expect('openWorkspace' in bundle.handoff).toBe(false);
    expect('closeWindow' in bundle.handoff).toBe(false);
    expect('hasUnsavedEditors' in bundle.handoff).toBe(false);

    const openWorkspace = async (): Promise<void> => undefined;
    const closeWindow = async (): Promise<void> => undefined;
    const given = buildRemoteRuntimeHandoff(
      harness({
        workspaceRoot: '/workspace',
        openWorkspace,
        closeWindow,
        hasUnsavedEditors: () => false,
      }).input,
    );
    expect(given.handoff.workspaceRoot).toBe('/workspace');
    expect(given.handoff.openWorkspace).toBe(openWorkspace);
    expect(given.handoff.closeWindow).toBe(closeWindow);
    expect(given.handoff.hasUnsavedEditors?.()).toBe(false);
  });

  it('reads the runtime through the callbacks, never a snapshot of them', async () => {
    const { input, names, stopActive, totpEnrolled, setDisposed, setConfig } = harness();
    const bundle = buildRemoteRuntimeHandoff(input);

    // A transport started after the build is visible, so `activeTransports` is
    // the manager and not a name list copied at construction.
    names.push('whatsapp');
    expect(bundle.handoff.activeTransports()).toEqual(['telegram', 'whatsapp']);

    expect(await bundle.handoff.stopTransports()).toBeUndefined();
    expect(stopActive).toHaveBeenCalledTimes(1);
    expect(await bundle.handoff.totpEnrolled('telegram')).toBe(true);
    expect(totpEnrolled).toHaveBeenCalledWith('telegram');

    // The case a plain value would pass: `isDisposed` and `requestedConfig`
    // flip after the bundle exists, and the bundle has to see the new state.
    expect(bundle.handoff.isDisposed()).toBe(false);
    setDisposed(true);
    expect(bundle.handoff.isDisposed()).toBe(true);

    const asked = { remote: { enabled: true } } as ForgeConfig;
    expect(bundle.handoff.requestedConfig()).toBeUndefined();
    setConfig(asked);
    expect(bundle.handoff.requestedConfig()).toBe(asked);
  });

  it('gives each window its own receipt gate', () => {
    const first = buildRemoteRuntimeHandoff(harness().input);
    expect(first.handoff.announceOnce('h1', true)).toBe(true);
    expect(first.handoff.announceOnce('h1', true)).toBe(false);
    expect(first.handoff.announceOnce('h2', true)).toBe(true);
    // A failure said once may still be followed by the success that replaces it.
    expect(first.handoff.announceOnce('h3', false)).toBe(true);
    expect(first.handoff.announceOnce('h3', false)).toBe(false);
    expect(first.handoff.announceOnce('h3', true)).toBe(true);
    // A second runtime gets a fresh gate, not the first window's memory.
    const second = buildRemoteRuntimeHandoff(harness().input);
    expect(second.handoff.announceOnce('h1', true)).toBe(true);
  });
});
