import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ChatAttachmentStore } from '../../src/sidebar/ChatAttachmentStore';
import { displayPersistMessages } from '../../src/sidebar/sessionProjections';
import { chatMessagesFromSlim, slimPersistMessages } from '../../src/sidebar/sessionTypes';
import type { ChatMessage } from '../../src/llm/types';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'forge-attachments-'));
}

describe('ChatAttachmentStore', () => {
  it('writes the bytes and returns a reference that resolves back to them', async () => {
    const store = new ChatAttachmentStore(await tempRoot());
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const [ref] = await store.save('conv-1', [
      { name: 'shot.png', mediaType: 'image/png', data: png.toString('base64') },
    ]);

    expect(ref).toMatchObject({ name: 'shot.png', mediaType: 'image/png', bytes: png.length });
    expect(ref!.relativePath.startsWith('conv-1/')).toBe(true);
    expect(ref!.relativePath.endsWith('.png')).toBe(true);
    await expect(fs.readFile(store.resolve(ref!.relativePath))).resolves.toEqual(png);
  });

  it('refuses a reference that escapes the store', async () => {
    const store = new ChatAttachmentStore(await tempRoot());
    expect(() => store.resolve('../../secrets.env')).toThrow(/escapes/u);
  });

  it('prunes only the conversations that no longer exist', async () => {
    const root = await tempRoot();
    const store = new ChatAttachmentStore(root);
    const file = { name: 'a.txt', mediaType: 'text/plain', data: 'hello' };
    await store.save('kept', [file]);
    await store.save('gone', [file]);

    await store.prune(['kept']);

    await expect(fs.readdir(root)).resolves.toEqual(['kept']);
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
