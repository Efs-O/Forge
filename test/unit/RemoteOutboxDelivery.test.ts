import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteOutboxDelivery } from '../../src/remote/RemoteOutboxDelivery';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-outbox-delivery-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
}

async function addMessages(
  state: RemoteRequestStore,
  count: number,
  options: { ephemeralAt?: number } = {},
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await state.notifyOutbox('fake', 'chat-1', `message ${String(index)}\nsecond line`, {
      ephemeral: index === options.ephemeralAt,
    });
  }
}

function delivery(
  channel: FakeRemoteChannel,
  state: RemoteRequestStore,
  maxBacklog = 5,
  onError = vi.fn(),
  workspaceRoot?: string,
): RemoteOutboxDelivery {
  return new RemoteOutboxDelivery(
    channel,
    state,
    2_000,
    new AbortController().signal,
    10_000,
    onError,
    async () => true,
    undefined,
    undefined,
    maxBacklog,
    workspaceRoot,
  );
}

class MediaChannel extends FakeRemoteChannel {
  readonly sentMedia: Array<{ kind: string; chatId: string; filePath: string; caption: string }> =
    [];

  async sendVideo(chatId: string, filePath: string, caption: string): Promise<void> {
    this.sentMedia.push({ kind: 'video', chatId, filePath, caption });
  }

  async sendAudio(chatId: string, filePath: string, caption: string): Promise<void> {
    this.sentMedia.push({ kind: 'audio', chatId, filePath, caption });
  }

  async sendDocument(chatId: string, filePath: string, caption: string): Promise<void> {
    this.sentMedia.push({ kind: 'document', chatId, filePath, caption });
  }
}

describe('RemoteOutboxDelivery unlock backlog cap', () => {
  it('summarizes 13 held messages, then delivers the newest five in order', async () => {
    const state = await store();
    const channel = new FakeRemoteChannel();
    await addMessages(state, 18);
    const outbox = delivery(channel, state);

    outbox.start();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(6), { timeout: 10_000 });
    await outbox.stop();

    expect(channel.sent[0]?.text).toContain('Forge: 13 earlier messages were held back');
    for (let index = 1; index <= 13; index += 1) {
      expect(channel.sent[0]?.text).toContain(`message ${String(index)}`);
    }
    expect(channel.sent.slice(1).map((message) => message.text)).toEqual([
      'message 14\nsecond line',
      'message 15\nsecond line',
      'message 16\nsecond line',
      'message 17\nsecond line',
      'message 18\nsecond line',
    ]);
    const records = state.contactRead((snapshot) => snapshot.outbox);
    expect(records.slice(0, 13).every((item) => item.state === 'coalesced')).toBe(true);
    expect(records.slice(13).every((item) => item.state === 'delivered')).toBe(true);
  });

  it('keeps older media outbox items deliverable when text backlog is coalesced', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-outbox-media-'));
    tempDirs.push(directory);
    const workspace = path.join(directory, 'workspace');
    await fs.mkdir(path.join(workspace, 'media'), { recursive: true });
    const clip = path.join(workspace, 'media', 'clip.mp4');
    await fs.writeFile(clip, 'clip');
    const state = new RemoteRequestStore(path.join(directory, 'state.json'));
    await state.load();
    const channel = new MediaChannel();
    await state.notifyOutbox('fake', 'chat-1', 'older text');
    await state.notifyOutbox('fake', 'chat-1', 'video finished', {
      media: { kind: 'video', workspacePath: 'media/clip.mp4' },
    });
    await state.notifyOutbox('fake', 'chat-1', 'newer text');
    const outbox = delivery(channel, state, 1, vi.fn(), workspace);

    outbox.start();
    await vi.waitFor(() => expect(channel.sentMedia).toHaveLength(1));
    await outbox.stop();

    expect(channel.sentMedia[0]?.kind).toBe('video');
    expect(await fs.realpath(channel.sentMedia[0]!.filePath)).toBe(await fs.realpath(clip));
    const records = state.contactRead((snapshot) => snapshot.outbox);
    expect(records[1]?.state).toBe('delivered');
    expect(records[0]?.state).toBe('coalesced');
  });

  it('sends the Telegram preview and names the original path for an oversized render', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-outbox-preview-'));
    tempDirs.push(directory);
    const workspace = path.join(directory, 'workspace');
    const mediaDir = path.join(workspace, 'media');
    await fs.mkdir(mediaDir, { recursive: true });
    const original = path.join(mediaDir, 'large.mp4');
    const handle = await fs.open(original, 'w');
    await handle.truncate(50 * 1024 * 1024 + 1);
    await handle.close();
    const preview = path.join(mediaDir, 'large.telegram-preview.mp4');
    await fs.writeFile(preview, 'preview');
    const state = new RemoteRequestStore(path.join(directory, 'state.json'));
    await state.load();
    const channel = new MediaChannel();
    await state.notifyOutbox('fake', 'chat-1', 'Video render completed.', {
      media: {
        kind: 'video',
        workspacePath: 'media/large.mp4',
        previewPath: 'media/large.telegram-preview.mp4',
      },
    });
    const outbox = delivery(channel, state, 5, vi.fn(), workspace);
    // The preview is gone the moment the send lands, so its real path is taken
    // before the delivery starts.
    const previewReal = await fs.realpath(preview);

    outbox.start();
    await vi.waitFor(() => expect(channel.sentMedia).toHaveLength(1));
    await outbox.stop();

    expect(channel.sentMedia[0]!.filePath).toBe(previewReal);
    expect(channel.sentMedia[0]?.caption).toContain('media/large.mp4');
    // Nothing archives a preview: once the message landed, only the original the
    // caption names is left behind.
    await expect(fs.stat(preview)).rejects.toThrow();
  });

  it('deletes only a preview: a previewPath naming the original is left alone', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-outbox-preview-name-'));
    tempDirs.push(directory);
    const workspace = path.join(directory, 'workspace');
    const mediaDir = path.join(workspace, 'media');
    await fs.mkdir(mediaDir, { recursive: true });
    const original = path.join(mediaDir, 'large.mp4');
    await fs.writeFile(original, 'small enough to send whole');
    const state = new RemoteRequestStore(path.join(directory, 'state.json'));
    await state.load();
    const channel = new MediaChannel();
    await state.notifyOutbox('fake', 'chat-1', 'Video render completed.', {
      media: {
        kind: 'video',
        workspacePath: 'media/large.mp4',
        previewPath: 'media/large.mp4',
      },
    });
    const outbox = delivery(channel, state, 5, vi.fn(), workspace);

    outbox.start();
    await vi.waitFor(() => expect(channel.sentMedia).toHaveLength(1));
    await outbox.stop();

    expect(await fs.realpath(channel.sentMedia[0]!.filePath)).toBe(await fs.realpath(original));
    expect(await fs.readFile(original, 'utf8')).toBe('small enough to send whole');
  });

  it('omits ephemeral lines from the summary and preserves an uncapped backlog', async () => {
    const state = await store();
    const channel = new FakeRemoteChannel();
    await addMessages(state, 7, { ephemeralAt: 2 });
    const outbox = delivery(channel, state);

    outbox.start();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(6));
    await outbox.stop();

    expect(channel.sent[0]?.text).toContain('message 1');
    expect(channel.sent[0]?.text).not.toContain('message 2');
    expect(channel.sent[0]?.text).not.toContain('second line');
    expect(channel.sent.slice(1).map((message) => message.text)).toEqual([
      'message 3\nsecond line',
      'message 4\nsecond line',
      'message 5\nsecond line',
      'message 6\nsecond line',
      'message 7\nsecond line',
    ]);

    const uncappedState = await store();
    const uncappedChannel = new FakeRemoteChannel();
    await addMessages(uncappedState, 5);
    const uncapped = delivery(uncappedChannel, uncappedState);
    uncapped.start();
    await vi.waitFor(() => expect(uncappedChannel.sent).toHaveLength(5));
    await uncapped.stop();
    expect(uncappedChannel.sent.map((message) => message.text)).toEqual(
      Array.from({ length: 5 }, (_, index) => `message ${String(index + 1)}\nsecond line`),
    );
  });

  it('restores all coalesced records when sending the summary fails', async () => {
    const state = await store();
    const channel = new FakeRemoteChannel();
    const onError = vi.fn();
    channel.sendError = 'summary failed';
    await addMessages(state, 18);
    const outbox = delivery(channel, state, 5, onError);

    outbox.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    await outbox.stop();

    expect(
      state.contactRead((snapshot) => snapshot.outbox).every((item) => item.state === 'pending'),
    ).toBe(true);
  });
});
