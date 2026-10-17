import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as atomicWrite from '../../src/util/atomicWrite';
import { ArchivedSessions } from '../../src/sidebar/ArchivedSessions';
import { ChatAttachmentStore } from '../../src/sidebar/ChatAttachmentStore';
import { SidebarProvider } from '../../src/sidebar/SidebarProvider';
import { displayPersistMessages } from '../../src/sidebar/sessionProjections';
import { chatMessagesFromSlim, slimPersistMessages } from '../../src/sidebar/sessionTypes';
import type { ChatMessage } from '../../src/llm/types';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-attachments-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('ChatAttachmentStore', () => {
  it('writes the bytes and returns a reference that resolves back to them', async () => {
    const store = new ChatAttachmentStore(await tempRoot(), 'workspace-a');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const saved = await store.save('conv-1', [
      { name: 'shot.png', mediaType: 'image/png', data: png.toString('base64') },
    ]);
    const [ref] = saved.refs;

    expect(saved.failures).toEqual([]);
    expect(ref).toMatchObject({ name: 'shot.png', mediaType: 'image/png', bytes: png.length });
    expect(ref!.relativePath.startsWith('conv-1/')).toBe(true);
    expect(ref!.relativePath.endsWith('.png')).toBe(true);
    await expect(fs.readFile(store.resolve(ref!.relativePath))).resolves.toEqual(png);
    await expect(fs.readFile(path.join(store.rootPath, 'conv-1', '.owner'), 'utf8')).resolves.toBe(
      'workspace-a',
    );
  });

  it('refuses a reference that escapes the store', async () => {
    const store = new ChatAttachmentStore(await tempRoot(), 'workspace-a');
    expect(() => store.resolve('../../secrets.env')).toThrow(/escapes/u);
  });

  it('keeps another workspace during pruning and deletes dead chats owned by this workspace', async () => {
    const root = await tempRoot();
    const store = new ChatAttachmentStore(root, 'workspace-b');
    for (const [id, owner] of [
      ['workspace-a-chat', 'workspace-a'],
      ['workspace-b-live', 'workspace-b'],
      ['workspace-b-dead', 'workspace-b'],
    ]) {
      const directory = path.join(root, id);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, '.owner'), owner);
    }

    await store.prune(['workspace-b-live']);

    await expect(fs.stat(path.join(root, 'workspace-a-chat'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, 'workspace-b-live'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, 'workspace-b-dead'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves legacy directories without an owner marker', async () => {
    const root = await tempRoot();
    const store = new ChatAttachmentStore(root, 'workspace-a');
    const legacy = path.join(root, 'legacy-chat');
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, 'old.png'), Buffer.from([1, 2, 3]));

    await store.prune([]);

    await expect(fs.readFile(path.join(legacy, 'old.png'))).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it('keeps overflow archive chat attachments live and confirms the chat is restorable', async () => {
    const root = await tempRoot();
    const archive = new ArchivedSessions(path.join(root, 'storage'), root, path.join(root, 'logs'));
    const id = 'overflow-chat';
    archive.put({
      id,
      title: 'Archived chat',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    });
    expect(archive.read(id)).toMatchObject({ id, title: 'Archived chat' });

    // Exercise the production live-ID method without constructing the full VS Code provider.
    const provider = {
      sidebar: { conversations: [], history: [] },
      historyArchive: { overflow: archive },
    };
    const liveIds = SidebarProvider.prototype.liveConversationIds.call(
      provider as unknown as SidebarProvider,
    );
    const store = new ChatAttachmentStore(path.join(root, 'attachments'), 'workspace-a');
    const saved = await store.save(id, [
      {
        name: 'archived.png',
        mediaType: 'image/png',
        data: Buffer.from([7, 8]).toString('base64'),
      },
    ]);

    await store.prune(liveIds);

    expect(liveIds).toContain(id);
    expect(saved.refs).toHaveLength(1);
    await expect(fs.stat(path.join(store.rootPath, id))).resolves.toBeDefined();
  });

  it('returns successful refs and filenames when a later attachment write fails', async () => {
    const root = await tempRoot();
    const store = new ChatAttachmentStore(root, 'workspace-a');
    const writeFileAtomic = atomicWrite.writeFileAtomic;
    let writes = 0;
    vi.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation(async (...args) => {
      writes += 1;
      if (writes === 3) throw new Error('disk full');
      return writeFileAtomic(...args);
    });

    try {
      const saved = await store.save(
        'partial-chat',
        ['one.png', 'two.png', 'three.png', 'four.png', 'five.png'].map((name) => ({
          name,
          mediaType: 'image/png',
          data: Buffer.from(name).toString('base64'),
        })),
      );

      expect(saved.refs.map((ref) => ref.name)).toEqual([
        'one.png',
        'two.png',
        'four.png',
        'five.png',
      ]);
      expect(saved.failures).toEqual([{ name: 'three.png', error: 'disk full' }]);
      await expect(fs.readFile(store.resolve(saved.refs[0]!.relativePath))).resolves.toEqual(
        Buffer.from('one.png'),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('attachment references on the transcript', () => {
  const withImage: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
      attachments: [
        { name: 'shot.png', mediaType: 'image/png', bytes: 4, relativePath: 'c/shot.png' },
      ],
    },
  ];

  it('keeps the prompt and its references in the display projection', () => {
    // The array-content turn used to be dropped whole: after a reload the
    // prompt text disappeared along with the image.
    const rows = displayPersistMessages(withImage);
    expect(rows).toEqual([
      {
        role: 'user',
        content: 'what is in this?',
        attachments: [
          { name: 'shot.png', mediaType: 'image/png', bytes: 4, relativePath: 'c/shot.png' },
        ],
      },
    ]);
  });

  it('persists the reference but never the pixels', () => {
    const slim = slimPersistMessages(withImage);
    expect(JSON.stringify(slim)).not.toContain('AAAA');
    expect(slim[0]!.attachments).toEqual(withImage[0]!.attachments);
    expect(chatMessagesFromSlim(slim)[0]!.attachments).toEqual(withImage[0]!.attachments);
  });
});
