/**
 * `/workspace windows`, its `✕` per row, `/workspace cap` and `/workspace close`,
 * plus the two gates the plan says this feature cannot ship without: owner-only
 * with an unlocked session, and a cap that refuses `new-window` alone.
 *
 * Phase 3 of `docs/plans/TELEGRAM_WORKSPACE_SWITCH_SAFETY_PLAN.md`. The window
 * surface is faked everywhere, so these tests are about what the phone is told
 * and what it is allowed to do — the filesystem and PowerShell have their own
 * files (`RemoteWindowRegistry.test.ts`, `RemoteWindowsProbe.test.ts`).
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemorySecrets } from '../support/memorySecrets';
import { createTelegramContactFixture, cleanupTelegramContactFixtures } from '../support/telegramContactFixture';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { handleRemoteCommand } from '../../src/remote/RemoteCommandHandler';
import { handleRemoteSelectionAction } from '../../src/remote/RemoteSelectionPager';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { generateTotp } from '../../src/remote/RemoteTotp';
import { SELECTION_TTL_MS } from '../../src/remote/RemoteSelectionConstants';
import type { RemoteWindowSurface } from '../../src/remote/RemoteWindowRegistry';
import type { RemoteInboundEvent, RemoteInboundDisposition } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await cleanupTelegramContactFixtures();
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

/** Every text a fake channel has been asked to put on screen, keyboard included. */
function allTexts(channel: FakeRemoteChannel): string {
  return [
    ...channel.sent.map((message) => message.text),
    ...channel.selectionChoiceSends.map((keyboard) => keyboard.text),
    ...channel.selectionPageSends.map((page) => page.text),
  ].join('\n');
}

async function requestStore(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workspace-windows-'));
  tempDirs.push(directory);
  const store = new RemoteRequestStore(path.join(directory, 'state.json'));
  await store.load();
  return store;
}

function textEvent(text: string, providerMessageId: string): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return {
    channel: 'fake',
    kind: 'text',
    providerMessageId,
    senderId: 'owner',
    chatId: 'chat',
    chatType: 'private',
    receivedAt: 1,
    text,
  };
}

function selectionEvent(
  choice: number,
  token: string,
  messageId: string,
): Extract<RemoteInboundEvent, { kind: 'selection' }> {
  return {
    channel: 'fake',
    kind: 'selection',
    providerMessageId: `callback-${messageId}`,
    senderId: 'owner',
    chatId: 'chat',
    chatType: 'private',
    receivedAt: 1,
    messageId,
    selectionKind: 'workspaces',
    selectionToken: token,
    action: 'select',
    choice,
  };
}

function idleHost(): ForgeHostFacade {
  return {
    status: () => ({
      activeConversationId: 'visible',
      conversations: [],
      requestChains: [],
      streamingConversationIds: [],
      pendingApproval: undefined,
    }),
    // The controller subscribes to these on `start()`, so a host that cannot
    // answer them is not a host at all.
    addApprovalSink: () => ({ dispose: () => undefined }),
    addQuestionSink: () => ({ dispose: () => undefined }),
    answerQuestion: () => false,
    restoreConversation: vi.fn(),
    send: vi.fn(async () => ({ kind: 'completed' as const, finalText: 'done' })),
    cancel: vi.fn(async () => undefined),
  } as unknown as ForgeHostFacade;
}

const ALIVE = '4242424-1700000000000';
const OTHER = '4141414-1700000000000';

/** The window files, as the phone sees them: rows, a count, and a Close button. */
function fakeSurface(
  options: {
    rows?: Array<{ windowId: string; name: string; closable: boolean; whyNotClosable?: string }>;
    cap?: number;
    refusal?: string;
    counted?: 'os' | 'files';
  } = {},
): RemoteWindowSurface & {
  closeRequests: string[];
  capChecks: string[];
  capSets: number[];
} {
  const rows = options.rows ?? [
    { windowId: ALIVE, name: 'Forge', closable: false, whyNotClosable: 'it is answering this phone' },
    { windowId: OTHER, name: 'Strata', closable: true },
  ];
  const closeRequests: string[] = [];
  const capChecks: string[] = [];
  const capSets: number[] = [];
  return {
    closeRequests,
    capChecks,
    capSets,
    async list() {
      return {
        rows: rows.map((row) => ({
          windowId: row.windowId,
          name: row.name,
          workspace: `N:\\${row.name}`,
          closable: row.closable,
          ...(row.whyNotClosable ? { whyNotClosable: row.whyNotClosable } : {}),
          serving: !row.closable,
        })),
        count: {
          total: rows.length + (options.counted === 'os' ? 2 : 0),
          forgeWindows: rows.map((row) => row.name),
          otherWindows: options.counted === 'os' ? 2 : 0,
          counted: options.counted ?? 'files',
          probeReason: 'Forge cannot enumerate VS Code windows on linux',
        },
      };
    },
    async capRefusal(alias: string) {
      capChecks.push(alias);
      return options.refusal;
    },
    async requestClose(windowId: string) {
      closeRequests.push(windowId);
      return { ok: true };
    },
    cap: () => options.cap ?? 5,
    async setCap(cap: number) {
      capSets.push(cap);
    },
  };
}

async function commandContext(
  channel: FakeRemoteChannel,
  store: RemoteRequestStore,
  surface: RemoteWindowSurface,
  switched: string[],
  modes: string[] = [],
) {
  return {
    channel,
    store,
    host: idleHost(),
    workspaceId: 'ws-forge',
    signal: new AbortController().signal,
    inactivityTimeoutMinutes: 30,
    rateLimitPerMinute: 30,
    modelEntries: [],
    workspaceAliases: { forge: 'Forge', other: 'Other' },
    currentWorkspaceAlias: 'forge',
    currentWorkspaceName: 'Forge',
    windowSurface: surface,
    switchWorkspace: async (
      alias: string,
      _channel: string,
      _chatId: string,
      mode: string,
    ): Promise<() => Promise<void>> => {
      switched.push(alias);
      modes.push(mode);
      return async () => undefined;
    },
  };
}

function selectionContext(
  channel: FakeRemoteChannel,
  store: RemoteRequestStore,
  surface: RemoteWindowSurface,
) {
  return {
    channel,
    store,
    host: idleHost(),
    signal: new AbortController().signal,
    workspaceId: 'ws-forge',
    modelEntries: [],
    workspaceAliases: { forge: 'Forge', other: 'Other' },
    currentWorkspaceAlias: 'forge',
    currentWorkspaceName: 'Forge',
    windowSurface: surface,
  };
}

describe('/workspace windows', () => {
  it('lists each window with its workspace and a ✕ only on the ones Forge may close', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const surface = fakeSurface();
    await handleRemoteCommand(
      textEvent('/workspace windows', 'list-1'),
      await commandContext(channel, store, surface, []),
      'list-1',
    );
    const keyboard = channel.selectionChoiceSends[0];
    expect(keyboard?.text).toContain('1. Forge');
    expect(keyboard?.text).toContain('N:\\Forge');
    expect(keyboard?.text).toContain('it is answering this phone');
    expect(keyboard?.text).toContain('2. Strata');
    // The row that is answering the phone has no Close button: the plan says a
    // phone close of the serving window is refused outright, and offering it
    // would be a dead button.
    expect(keyboard?.choices.map((choice) => choice.label)).toEqual(['✕ Strata']);
    expect(keyboard?.choices[0]?.value).toBe(1);
    expect(keyboard?.controls.kind).toBe('workspaces');
    expect(keyboard?.text).toContain('Forge never closes a window on its own');
  });

  it('says what it counted when the OS could not be asked', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const surface = fakeSurface({ counted: 'files' });
    await handleRemoteCommand(
      textEvent('/workspace windows', 'list-2'),
      await commandContext(channel, store, surface, []),
      'list-2',
    );
    expect(channel.selectionChoiceSends[0]?.text).toContain(
      'counted only windows it can see here',
    );
  });

  it('writes one close-request per tap and keeps the keyboard up so several can be closed', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const surface = fakeSurface({
      rows: [
        { windowId: ALIVE, name: 'Forge', closable: false },
        { windowId: OTHER, name: 'Strata', closable: true },
        { windowId: '999-9', name: 'Media', closable: true },
      ],
    });
    const context = await commandContext(channel, store, surface, []);
    await handleRemoteCommand(textEvent('/workspace windows', 'list-3'), context, 'list-3');
    const token = channel.selectionChoiceSends[0]!.controls.token;
    const taps = await Promise.all([
      handleRemoteSelectionAction(
        selectionEvent(1, token, 'tap-1'),
        selectionContext(channel, store, surface),
        'tap-1',
      ),
      handleRemoteSelectionAction(
        selectionEvent(2, token, 'tap-2'),
        selectionContext(channel, store, surface),
        'tap-2',
      ),
    ]);
    expect(taps.every((result: RemoteInboundDisposition) => result.kind === 'handled')).toBe(true);
    expect(surface.closeRequests).toEqual([OTHER, '999-9']);
    expect(channel.sent.map((message: { text: string }) => message.text).join('\n')).toContain(
      'asked Strata to close itself',
    );
    // A tap on the row that is answering the phone is refused before anything is
    // written, because that window cannot close itself from the phone.
    const refused = await handleRemoteSelectionAction(
      selectionEvent(0, token, 'tap-own'),
      selectionContext(channel, store, surface),
      'tap-own',
    );
    expect(refused.kind).toBe('rejected');
    expect(surface.closeRequests).toEqual([OTHER, '999-9']);
  });

  it('refuses a tap that arrives after the list expired', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const surface = fakeSurface();
    const context = await commandContext(channel, store, surface, []);
    await handleRemoteCommand(textEvent('/workspace windows', 'list-4'), context, 'list-4');
    const token = channel.selectionChoiceSends[0]!.controls.token;
    vi.useFakeTimers();
    vi.advanceTimersByTime(SELECTION_TTL_MS + 1);
    const late = await handleRemoteSelectionAction(
      selectionEvent(1, token, 'tap-late'),
      selectionContext(channel, store, surface),
      'tap-late',
    );
    expect(late.kind).toBe('rejected');
    expect((late as { reason: string }).reason).toContain('expired');
    expect(surface.closeRequests).toEqual([]);
    vi.useRealTimers();
  });

  it('refuses a number typed while the window list is the live list', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const surface = fakeSurface();
    const context = await commandContext(channel, store, surface, []);
    await handleRemoteCommand(textEvent('/workspace windows', 'list-5'), context, 'list-5');
    await expect(
      handleRemoteCommand(textEvent('/workspace 2', 'number-5'), context, 'number-5'),
    ).resolves.toMatchObject({
      kind: 'rejected',
      reason: expect.stringContaining('open-window list'),
    });
  });

  it('answers /workspace close <row> for a transport without choice buttons', async () => {
    const store = await requestStore();
    // A channel with no `selectionPages` at all: WhatsApp gets the typed form.
    const plain = new FakeRemoteChannel();
    (plain as unknown as { selectionPages?: unknown }).selectionPages = undefined;
    const surface = fakeSurface();
    const context = await commandContext(plain, store, surface, []);
    await handleRemoteCommand(textEvent('/workspace windows', 'list-6'), context, 'list-6');
    await expect(
      handleRemoteCommand(textEvent('/workspace close 2', 'close-6'), context, 'close-6'),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(surface.closeRequests).toEqual([OTHER]);
    await expect(
      handleRemoteCommand(textEvent('/workspace close 9', 'close-9'), context, 'close-9'),
    ).resolves.toMatchObject({ kind: 'rejected', reason: expect.stringContaining('1-2') });
  });
});

describe('/workspace cap', () => {
  it('reports the limit and sets it, and refuses a number outside the range', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const surface = fakeSurface();
    const context = await commandContext(channel, store, surface, []);
    await handleRemoteCommand(textEvent('/workspace cap', 'cap-1'), context, 'cap-1');
    expect(channel.sent.at(-1)?.text).toContain('the new-window limit is 5');
    await expect(
      handleRemoteCommand(textEvent('/workspace cap 7', 'cap-2'), context, 'cap-2'),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(surface.capSets).toEqual([7]);
    for (const bad of ['0', '13', 'seven']) {
      await expect(
        handleRemoteCommand(textEvent(`/workspace cap ${bad}`, `cap-${bad}`), context, `cap-${bad}`),
      ).resolves.toMatchObject({ kind: 'rejected', reason: expect.stringContaining('1-12') });
    }
    expect(surface.capSets).toEqual([7]);
  });

  it('refuses a new-window switch at the limit, and never asks for a replace', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const surface = fakeSurface({
      refusal:
        '5 VS Code windows open — Forge, Strata, plus 3 other VS Code windows Forge cannot close. ' +
        'The limit is 5: close one with /workspace windows and its ✕, or raise the limit with ' +
        '/workspace cap <1-12>. Forge will not close a window on its own initiative.',
    });
    const switched: string[] = [];
    const modes: string[] = [];
    const context = await commandContext(channel, store, surface, switched, modes);
    // `replace` reloads this window and adds nothing, so the cap is not even asked.
    await handleRemoteCommand(
      textEvent('/workspace other replace', 'replace-1'),
      context,
      'replace-1',
    );
    expect(surface.capChecks).toEqual([]);
    expect(switched).toEqual(['other']);
    // `new-window` is the only mode that can add a window, so it is the only one
    // the check refuses.
    const refused = await handleRemoteCommand(
      textEvent('/workspace other new-window', 'new-1'),
      context,
      'new-1',
    );
    expect(refused.kind).toBe('rejected');
    expect(surface.capChecks).toEqual(['other']);
    expect(switched).toEqual(['other']);
    expect((refused as { reason: string }).reason).toContain(
      'other VS Code windows Forge cannot close',
    );
    // A refused switch closes nothing: the cap refuses, it does not make room,
    // and no close-request file was written on the phone's behalf.
    expect(surface.closeRequests).toEqual([]);
    // The refusal came before any promise: nothing told the phone it was opening.
    expect(
      channel.sent.some((message: { text: string }) =>
        message.text.includes('opening Other in a new window'),
      ),
    ).toBe(false);
  });

  it('does not refuse a target that is already open, because the surface declined to', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    // The surface is the one that knows the folder is already open — it returns
    // `undefined` for it, and the command switches. `RemoteWindowRegistry.test.ts`
    // proves the surface itself declines, on a real workspace id.
    const surface = fakeSurface({ refusal: undefined });
    const switched: string[] = [];
    const context = await commandContext(channel, store, surface, switched);
    await expect(
      handleRemoteCommand(
        textEvent('/workspace other new-window', 'new-2'),
        context,
        'new-2',
      ),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(switched).toEqual(['other']);
    expect(surface.capChecks).toEqual(['other']);
  });
});

describe('who may use the window commands', () => {
  it('refuses a contact, who never reaches the command list at all', async () => {
    const fixture = await createTelegramContactFixture({ prefix: 'forge-windows-contact-' });
    for (const command of ['/workspace windows', '/workspace cap 7', '/workspace close 1']) {
      await expect(
        fixture.service.handleNonOwner({
          channel: 'telegram',
          kind: 'text',
          providerMessageId: `contact-${command}`,
          senderId: '20',
          chatId: '20',
          chatType: 'private',
          receivedAt: 1,
          text: command,
        } as RemoteInboundEvent),
      ).resolves.toMatchObject({ kind: 'rejected' });
    }
    // Nothing was written: a contact cannot ask a window to close.
    expect(fixture.channel.sent.filter((message) => message.chatId === '20')).toHaveLength(0);
    fixture.dispose();
  });

  it('challenges a locked session before the window list is ever sent', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-windows-locked-'));
    tempDirs.push(directory);
    const store = new RemoteRequestStore(path.join(directory, 'state.json'));
    await store.load();
    const secrets = new MemorySecrets();
    await secrets.store('forge.remote.fake.ownerId', 'owner-raw-id');
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    const secret = await auth.createTotpEnrollmentSecret('fake');
    const now = Date.now();
    const code = generateTotp(secret, now).code;
    await auth.confirmTotpEnrollment('fake', secret, code, now);
    const channel = new FakeRemoteChannel();
    const surface = fakeSurface();
    const controller = new RemoteController(
      channel,
      store,
      auth,
      idleHost(),
      {
        workspaceId: 'workspace',
        queueLimit: 5,
        maxMessageChars: 12_000,
        rateLimitPerMinute: 30,
        workspaceAliases: { forge: 'Forge' },
        windowSurface: surface,
      } as never,
    );
    await controller.start();
    // The events carry the owner's raw id, because `RemoteAuth.isOwner` compares
    // the sender against the stored `forge.remote.fake.ownerId`.
    const fromOwner = (text: string, providerMessageId: string): RemoteInboundEvent => ({
      ...textEvent(text, providerMessageId),
      senderId: 'owner-raw-id',
    });
    try {
      const locked = await channel.emit(fromOwner('/workspace windows', 'locked-1'));
      expect(locked.kind).toBe('handled');
      // Challenged, not answered: the list itself was never sent, so a locked
      // chat cannot even learn which projects the owner has open. The window
      // list goes out as a choice keyboard, so every text this assertion looks
      // at has to include the keyboards as well as the plain sends.
      expect(allTexts(channel)).not.toContain('Open windows');
      expect(allTexts(channel)).toContain('6-digit code');
      await channel.emit(fromOwner(code, 'code-1'));
      const unlocked = await channel.emit(fromOwner('/workspace windows', 'locked-2'));
      expect(unlocked.kind).toBe('handled');
      expect(allTexts(channel)).toContain('Open windows');
    } finally {
      await controller.stop();
    }
  });
});
