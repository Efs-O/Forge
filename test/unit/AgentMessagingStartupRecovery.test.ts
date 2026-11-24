import * as fs from 'fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { busPaths } from '../../src/agentBus/agentBus';
import { processIsAlive } from '../../src/agentBus/windowEndpoints';
import { readVerdictArtifact } from '../../src/agentMesh/verdictArtifact';
import { PendingAgentReplies } from '../../src/agentLinks/pendingAgentReplies';
import type { AgentSenderMetadata } from '../../src/agentLinks/chatAgentLinks';
import type { ForgeConfig } from '../../src/config/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import { setupAgentMessaging } from '../../src/vscode/agentMessagingSetup';

const { fakeHome, warnings } = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return {
    fakeHome: {
      dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'forge-startup-recovery-')),
    },
    warnings: [] as string[],
  };
});

// `setupAgentMessaging` builds the bus paths itself from `os.homedir()`, so the
// window under test gets a temporary profile: its pending-reply store, outbox
// and exchanges log land here instead of in the operator's `~/.forge`.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => fakeHome.dir };
});

// The window: the shared fake, plus the two members activation touches —
// `window.state` (route focus) and `window.onDidChangeWindowState` (registered
// by setup) — and a `showWarningMessage` that records, because the whole point
// of this file is which warnings startup produced and which it did not.
vi.mock('vscode', async () => {
  const support = await import('../support/vscode');
  return {
    ...support,
    commands: { ...support.commands, getCommands: async () => [] },
    window: {
      ...support.window,
      state: { focused: true },
      onDidChangeWindowState: () => ({ dispose: () => undefined }),
      showWarningMessage: async (...args: unknown[]) => {
        warnings.push(String(args[0] ?? ''));
        return undefined;
      },
    },
  };
});

const WORKSPACE = 'C:/workspace-under-test';
const CHAT_ID = '417b2fe9-0000-4000-8000-000000000001';
const sender: AgentSenderMetadata = {
  kind: 'claude',
  sessionId: '00000000-0000-4000-8000-000000000101',
  title: 'Claude review',
};

/** The provider shape `setupAgentMessaging` asks for, taken from its own
 *  signature so the fake cannot drift from the real seam. */
type WindowSidebar = Parameters<typeof setupAgentMessaging>[1];

function fakeSidebar(chatId: string, title: string) {
  let recoveryReplyRoute: import('../../src/agentLinks/pendingAgentReplies').RecoveryReplyRoute | undefined;
  const facade = {
    status: () => ({
      activeConversationId: chatId,
      conversations: [{ id: chatId, title, updatedAt: 1 }],
      requestChains: [],
      streamingConversationIds: [],
    }),
    getAgentLink: () => undefined,
    getConversation: () => ({ id: chatId, recoveryReplyRoute }),
    setRecoveryReplyRoute: (_id: string, route: typeof recoveryReplyRoute) => {
      recoveryReplyRoute = route;
      return true;
    },
    showConversationNotice: vi.fn(),
    restoreConversation: vi.fn(async () => ({ id: chatId, title })),
    emitHostActivity: vi.fn(),
  } as unknown as ForgeHostFacade;
  const sidebar = {
    getHostFacade: () => facade,
    tellDrain: { registerSource: vi.fn() },
  } as unknown as WindowSidebar;
  return { facade, sidebar };
}

/** A pid this process can prove is dead: `recover()` decides owner death with
 *  the real `processIsAlive`, and setup gives it no injection point. */
function aDeadPid(): number {
  for (const pid of [99999, 4000000, 4000004, 4000008]) {
    if (!processIsAlive(pid)) return pid;
  }
  throw new Error('no dead pid available on this machine');
}

const busRoot = busPaths(fakeHome.dir).root;
const disposables: { dispose(): void }[] = [];

afterAll(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  fs.rmSync(fakeHome.dir, { recursive: true, force: true });
});

describe('pending-reply recovery at window startup', () => {
  it('waits for the sidebar, then finishes an owner-dead record', async () => {
    // The record a crash leaves behind: a reply owed to an agent, its owning
    // window gone. Written before setup, as it is on disk before activation.
    const deadPid = aDeadPid();
    const pending = new PendingAgentReplies(busRoot, () => Date.now(), deadPid);
    const record = pending.create(sender, CHAT_ID, WORKSPACE);
    expect(processIsAlive(deadPid)).toBe(false);

    // Activation order, exactly as `activate()` has it: `setupAgentMessaging`
    // runs inside `wireControlServer`, and the provider is assigned afterwards.
    // `getSidebar` is the closure over that late assignment, so at setup time it
    // hands back nothing — the state that produced one warning per pending
    // reply on 2026-10-30 ("Cannot read properties of undefined (reading
    // 'getHostFacade')").
    let sidebar: WindowSidebar | undefined;
    warnings.length = 0;
    const wiring = setupAgentMessaging(
      {
        subscriptions: {
          push: (disposable: { dispose(): void }) => disposables.push(disposable),
        },
      } as never,
      () => sidebar as WindowSidebar,
      () => ({ models: [], profiles: {} }) as unknown as ForgeConfig,
      WORKSPACE,
    );

    // Setup must not have touched the sidebar: recovery is the window's own
    // call, made once the provider exists. No warning, and the record is
    // still waiting to be recovered by whoever asks.
    expect(warnings).toEqual([]);
    expect(pending.list().map((item) => item.exchangeId)).toEqual([record.exchangeId]);

    // The sidebar now exists, and with it the window's chat list:
    // `SidebarProvider`'s constructor loads it synchronously from
    // `workspaceState`, so `status().conversations` is complete from the
    // moment it is assigned, without a webview or `resolveWebviewView`.
    const { facade, sidebar: provider } = fakeSidebar(CHAT_ID, 'Review chat');
    sidebar = provider;

    await wiring.recoverPendingReplies();

    // Recovered, not dropped: the record is finished as "Forge restarted
    // before answering", its chat restored without stealing the active tab,
    // and nothing warned about it.
    expect(pending.list()).toEqual([]);
    expect(facade.restoreConversation).toHaveBeenCalledWith(CHAT_ID, { activate: false });
    expect(readVerdictArtifact(busPaths(fakeHome.dir), record.exchangeId, 'claude')).toContain(
      'Forge restarted before answering.',
    );
    expect(warnings).toEqual([]);
  });
});
