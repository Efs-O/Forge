import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import {
  handleRemoteCommand,
  type RemoteCommandContext,
} from '../../src/remote/RemoteCommandHandler';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import {
  sendWorkspaceSelection,
  type RemoteSelectionContext,
} from '../../src/remote/RemoteSelectionPager';
import type { RemoteInboundEvent } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function requestStore(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-workspace-selection-'));
  tempDirs.push(directory);
  const store = new RemoteRequestStore(path.join(directory, 'state.json'));
  await store.load();
  return store;
}

function textEvent(text: string): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return {
    channel: 'fake',
    kind: 'text',
    providerMessageId: `message-${text}`,
    senderId: 'owner',
    chatId: 'chat',
    chatType: 'private',
    receivedAt: 1,
    text,
  };
}

const emptyHost = {
  status: () => ({
    conversations: [],
    requestChains: [],
    streamingConversationIds: [],
    pendingApproval: undefined,
  }),
} as unknown as ForgeHostFacade;

function context(
  channel: FakeRemoteChannel,
  store: RemoteRequestStore,
  aliases: Record<string, string>,
  current?: string,
): RemoteSelectionContext {
  return {
    channel,
    store,
    host: emptyHost,
    signal: new AbortController().signal,
    modelNames: [],
    workspaceAliases: aliases,
    ...(current ? { currentWorkspaceAlias: current } : {}),
  };
}

const manyAliases = (count: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`ws-${index + 1}`, `Workspace ${index + 1}`]),
  );

describe('workspace selection', () => {
  it('numbers aliases and marks the one this chat is already in', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = context(
      channel,
      store,
      { forge: 'Forge', qwen: 'Qwen Testing', ssuno: 'Ssuno' },
      'forge',
    );

    await expect(sendWorkspaceSelection(textEvent('/workspace list'), ctx)).resolves.toEqual({
      kind: 'handled',
    });

    const sent = channel.selectionPageSends[0]!;
    expect(sent.text).toContain('1. forge — Forge · current');
    expect(sent.text).toContain('2. qwen — Qwen Testing');
    expect(sent.text).not.toContain('Qwen Testing · current');
    // The numbering is the point of reusing the pager at all.
    expect(sent.text).toContain('/new <number>');
  });

  it('pages in tens and keeps numbering absolute across pages', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = context(channel, store, manyAliases(23));

    await sendWorkspaceSelection(textEvent('/workspace list'), ctx);
    const first = channel.selectionPageSends[0]!;
    expect(first.text).toContain('page 1/3');
    expect(first.text).toContain('10. ws-10');
    expect(first.text).not.toContain('11. ws-11');

    await sendWorkspaceSelection(textEvent('/workspace list'), ctx, '2');
    const second = channel.selectionPageSends[1]!;
    // Absolute, not restarting at 1 — /new 11 must mean the eleventh alias.
    expect(second.text).toContain('11. ws-11');
    expect(second.text).toContain('page 2/3');
  });

  it('rejects a page beyond the end instead of sending an empty list', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = context(channel, store, manyAliases(23));

    await expect(
      sendWorkspaceSelection(textEvent('/workspace list'), ctx, '4'),
    ).resolves.toMatchObject({ kind: 'rejected' });
    expect(channel.selectionPageSends).toHaveLength(0);
  });

  it('says where to configure aliases when none exist', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();

    await expect(
      sendWorkspaceSelection(textEvent('/workspace list'), context(channel, store, {})),
    ).resolves.toEqual({ kind: 'handled' });
    // A bare "none configured" is what made this feature undiscoverable.
    expect(channel.sent[0]?.text).toContain('remote.workspace_aliases');
  });

  it('issues a selection the number lookup can resolve', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = context(channel, store, { forge: 'Forge', qwen: 'Qwen Testing' });

    await sendWorkspaceSelection(textEvent('/workspace list'), ctx);
    const selection = store.selection('fake', 'chat', 'workspaces');
    expect(selection?.values).toEqual(['forge', 'qwen']);
  });
});

function commandContext(
  channel: FakeRemoteChannel,
  store: RemoteRequestStore,
  aliases: Record<string, string>,
  extra: Partial<RemoteCommandContext> = {},
): RemoteCommandContext {
  return {
    channel,
    store,
    host: emptyHost,
    workspaceId: 'ws',
    signal: new AbortController().signal,
    inactivityTimeoutMinutes: 30,
    modelNames: [],
    workspaceAliases: aliases,
    switchWorkspace: async () => undefined,
    ...extra,
  };
}

describe('/workspace command shape', () => {
  it('lists with no subcommand — the namespace has one verb', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = commandContext(channel, store, { forge: 'Forge', qwen: 'Qwen Testing' });

    await expect(
      handleRemoteCommand(textEvent('/workspace'), ctx, 'ws-bare'),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(channel.selectionPageSends[0]?.text).toContain('1. forge — Forge');
  });

  it('pages from the bare form and from the explicit verb', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = commandContext(channel, store, manyAliases(23));

    await handleRemoteCommand(textEvent('/workspace 2'), ctx, 'ws-page-bare');
    expect(channel.selectionPageSends[0]?.text).toContain('11. ws-11');

    // The top-level split used to drop this page number on the floor, so the
    // documented `/workspace list <page>` fallback silently returned page 1.
    await handleRemoteCommand(textEvent('/workspace list 3'), ctx, 'ws-page-verb');
    expect(channel.selectionPageSends[1]?.text).toContain('21. ws-21');
  });

  it('rejects an unknown subcommand rather than listing', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = commandContext(channel, store, { forge: 'Forge' });

    await expect(
      handleRemoteCommand(textEvent('/workspace create'), ctx, 'ws-unknown'),
    ).resolves.toMatchObject({ kind: 'rejected' });
    expect(channel.selectionPageSends).toHaveLength(0);
  });

  it('says which workspace you are in, alias or not', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = context(channel, store, { forge: 'Forge' });
    await sendWorkspaceSelection(textEvent('/workspace'), {
      ...ctx,
      currentWorkspaceName: 'Qwen testing',
    });
    expect(channel.selectionPageSends[0]?.text).toContain('You are in: Qwen testing');
  });

  it('blames the expired list, not the workspace, when a number resolves to nothing', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = commandContext(channel, store, manyAliases(30));

    const expired = await handleRemoteCommand(textEvent('/new 26'), ctx, 'new-expired');
    expect(expired).toMatchObject({ kind: 'rejected' });
    expect((expired as { reason: string }).reason).toContain('expired');

    await handleRemoteCommand(textEvent('/workspace 3'), ctx, 'new-list');
    await expect(handleRemoteCommand(textEvent('/new 26'), ctx, 'new-ok')).resolves.toMatchObject({
      kind: 'handled',
    });

    const outOfRange = await handleRemoteCommand(textEvent('/new 99'), ctx, 'new-range');
    expect((outOfRange as { reason: string }).reason).toContain('1-30');
  });
});
