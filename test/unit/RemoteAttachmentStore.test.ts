import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteAttachmentStore } from '../../src/remote/RemoteAttachmentStore';

/**
 * `fs.stat` failures the sweep has to survive. `vi.spyOn` cannot replace an
 * `fs/promises` export (the namespace is not configurable in ESM), so the one
 * call the sweep makes per conversation is wrapped here and steered per path.
 */
const statHarness = vi.hoisted(() => ({
  reject: null as Record<string, Error> | null,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>();
  return {
    ...real,
    stat: (directory: string, ...rest: unknown[]) => {
      const forced = statHarness.reject?.[directory];
      if (forced) return Promise.reject(forced);
      return (real.stat as (p: string, ...r: unknown[]) => unknown)(directory, ...rest);
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  statHarness.reject = null;
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

describe('RemoteAttachmentStore retention sweep', () => {
  /** A conversation directory in this workspace root's inbox. */
  async function inboxWithConversation(): Promise<{ root: string; conversation: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-prune-'));
    roots.push(root);
    const conversation = path.join(root, '.forge', 'remote-inbox', 'conversation-1');
    await fs.mkdir(conversation, { recursive: true });
    return { root, conversation };
  }

  it('skips a conversation directory that is gone by the time it is checked', async () => {
    const { root, conversation } = await inboxWithConversation();
    const store = new RemoteAttachmentStore(root);
    // The race the sweep has to survive: `readdir` answered with the directory,
    // and by the time its `stat` runs another window's sweep — or a workspace
    // delete — has taken it away. A prune error is not worth failing the
    // transports over, so the sweep moves on.
    statHarness.reject = {
      [conversation]: Object.assign(
        new Error(`ENOENT: no such file or directory, stat '${conversation}'`),
        { code: 'ENOENT' },
      ),
    };
    await expect(store.prune(0)).resolves.toBeUndefined();
    expect((await fs.readdir(path.join(root, '.forge', 'remote-inbox'))).sort()).toEqual([
      'conversation-1',
    ]);
  });

  it('still throws for a directory it cannot check for any other reason', async () => {
    const { root, conversation } = await inboxWithConversation();
    const store = new RemoteAttachmentStore(root);
    statHarness.reject = {
      [conversation]: Object.assign(
        new Error(`EPERM: operation not permitted, stat '${conversation}'`),
        { code: 'EPERM' },
      ),
    };
    await expect(store.prune(0)).rejects.toThrow('EPERM');
  });
});
