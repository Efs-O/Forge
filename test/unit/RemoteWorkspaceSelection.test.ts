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
    modelEntries: [],
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
    // The numbering is the point of reusing the pager at all, and the command
    // it names is the same one that listed: /workspace lists, /workspace 2 goes.
    expect(sent.text).toContain('/workspace <number>');
    // No page fallback here: the number after /workspace is a workspace.
    expect(sent.text).not.toContain('Page fallback');
  });

  it('sends page one and hands the whole list to the keyboard', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = context(channel, store, manyAliases(23));

    // /workspace takes NO page argument any more: the number after it is a
    // workspace, and reading it as a page is the collision this list caused.
    await sendWorkspaceSelection(textEvent('/workspace list'), ctx);
    const first = channel.selectionPageSends[0]!;
    expect(first.text).toContain('page 1/3');
    expect(first.text).toContain('10. ws-10');
    expect(first.text).not.toContain('11. ws-11');
    expect(first.controls).toMatchObject({ kind: 'workspaces', page: 0, pageCount: 3 });
    // Numbering stays absolute across pages because the stored selection holds
    // every alias, not just the page that was rendered.
    expect(store.selection('fake', 'chat', 'workspaces')?.values).toHaveLength(23);
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
    rateLimitPerMinute: 30,
    modelEntries: [],
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

  it('goes to the workspace a number names instead of reading it as a page', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const switched: string[] = [];
    const ctx = commandContext(channel, store, manyAliases(23), {
      switchWorkspace: async (alias) => {
        switched.push(alias);
      },
    });

    // The screenshot that prompted this: `/workspace 27` was answered with
    // "takes a page number (1-3)" for the workspace the user had just read off
    // this very list. 23 is out of page range and IS a real entry.
    await handleRemoteCommand(textEvent('/workspace'), ctx, 'ws-list');
    await expect(
      handleRemoteCommand(textEvent('/workspace 23'), ctx, 'ws-go'),
    ).resolves.toMatchObject({ kind: 'handled' });
    expect(switched).toEqual(['ws-23']);
    expect(channel.sent.at(-1)?.text).toContain('switching to Workspace 23');
  });

  it('refuses a switch to the workspace the chat is already in', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = commandContext(
      channel,
      store,
      { forge: 'Forge', qwen: 'Qwen' },
      { currentWorkspaceAlias: 'forge' },
    );

    // A reload costs the remote session, so spending one to arrive where the
    // chat already is drops the session for nothing.
    const rejected = await handleRemoteCommand(textEvent('/workspace forge'), ctx, 'ws-noop');
    expect(rejected).toMatchObject({ kind: 'rejected' });
    expect((rejected as { reason: string }).reason).toContain('/chats');
  });

  it('rejects an unknown subcommand rather than listing', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = commandContext(channel, store, { forge: 'Forge' });

    const rejected = await handleRemoteCommand(textEvent('/workspace create'), ctx, 'ws-unknown');
    expect(rejected).toMatchObject({ kind: 'rejected' });
    // The refusal names the lists rather than only saying no.
    expect((rejected as { reason: string }).reason).toContain('/workspace');
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

    // Bare /workspace stores every alias, so a number off any page resolves.
    await handleRemoteCommand(textEvent('/workspace'), ctx, 'new-list');
    // /new <n> is retained as a silent alias for the documented /workspace <n>.
    await expect(handleRemoteCommand(textEvent('/new 26'), ctx, 'new-ok')).resolves.toMatchObject({
      kind: 'handled',
    });
    await expect(
      handleRemoteCommand(textEvent('/workspace 26'), ctx, 'ws-ok'),
    ).resolves.toMatchObject({ kind: 'handled' });

    const outOfRange = await handleRemoteCommand(textEvent('/workspace 99'), ctx, 'new-range');
    expect((outOfRange as { reason: string }).reason).toContain('1-30');
  });
});
