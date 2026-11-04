import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteAttachmentStore } from '../../src/remote/RemoteAttachmentStore';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('RemoteAttachmentStore music sources', () => {
  it('retains audio bytes under an audio extension and loads them as base64', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-audio-'));
    roots.push(root);
    const store = new RemoteAttachmentStore(root);
    const bytes = Buffer.from('voice bytes');
    const [reference] = await store.save('conversation', 'request', [
      {
        name: 'voice.wav',
        mediaType: 'audio/x-wav',
        data: bytes.toString('base64'),
      },
    ]);

    expect(reference?.mediaType).toBe('audio/x-wav');
    expect(reference?.relativePath).toMatch(/\.wav$/u);
    const loaded = await store.load([reference!]);
    expect(loaded[0]).toMatchObject({ name: 'voice.wav', mediaType: 'audio/x-wav' });
    expect(Buffer.from(loaded[0]!.data, 'base64')).toEqual(bytes);
  });
});
