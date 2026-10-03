import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';
import { sendTelegramPhoto, TELEGRAM_MAX_PHOTO_BYTES } from '../../src/remote/TelegramPhoto';
import { TelegramChatQueue } from '../../src/remote/telegramSendQueue';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { makeSendFileTool } from '../../src/tools/sendFileTool';

// send_file resolves its path through WorkspacePaths, which reads the vscode
// workspace root. This suite otherwise never touches vscode, so the mock exists
// only to give that resolver a folder to contain the temp file.
vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

function setWorkspace(folder: string): void {
  (
    vscode.workspace as unknown as {
      workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
    }
  ).workspaceFolders = [{ uri: { fsPath: folder } }];
}

afterEach(() => {
  vi.useRealTimers();
});

function progressRig(canDeliver = true) {
  const channel = new FakeRemoteChannel();
  const progress = new RemoteAgentProgress(
    channel,
    new AbortController().signal,
    () => canDeliver,
    3_900,
    1_000,
  );
  return { channel, progress };
}

describe('RemoteAgentProgress.deliverImage', () => {
  it('reports 0 and sends nothing when no message is watching the turn', async () => {
    const { channel, progress } = progressRig();
    expect(progress.deliverImage('c1', 'C:/img/fox.jpg', 'fox')).toBe(0);
    await Promise.resolve();
    expect(channel.photos).toEqual([]);
  });

  it('sends the photo to the watching chat, after the narration that preceded it', async () => {
    vi.useFakeTimers();
    const { channel, progress } = progressRig();
    const order: string[] = [];
    const send = channel.send.bind(channel);
    channel.send = async (chatId, text, options) => {
      order.push(`text:${text}`);
      await send(chatId, text, options);
    };
    const sendPhoto = channel.sendPhoto.bind(channel);
    channel.sendPhoto = async (chatId, filePath, caption) => {
      order.push(`photo:${caption}`);
      await sendPhoto(chatId, filePath, caption);
    };
    progress.begin('c1', 'chat-a', 'message-1');

    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Drawing the fox now.' });
    expect(progress.deliverImage('c1', 'C:/img/fox.jpg', '🖼 grok-imagine: fox')).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(order).toEqual(['text:Drawing the fox now.', 'photo:🖼 grok-imagine: fox']);
    expect(channel.photos).toEqual([
      { chatId: 'chat-a', filePath: 'C:/img/fox.jpg', caption: '🖼 grok-imagine: fox' },
    ]);
  });

  it('does not send to a chat that may not receive deliveries', async () => {
    vi.useFakeTimers();
    const { channel, progress } = progressRig(false);
    progress.begin('c1', 'chat-a', 'message-1');
    progress.deliverImage('c1', 'C:/img/fox.jpg', 'fox');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.photos).toEqual([]);
  });
});

describe('UserNotificationService.deliverImage', () => {
  it('does not spend the notify_user burst budget', async () => {
    const notifications = new UserNotificationService();
    notifications.addSink(async () => 1);
    for (let index = 0; index < 8; index += 1) {
      await notifications.deliverImage({ conversationId: 'c1', text: 'img', imagePath: 'a.png' });
    }
    expect(notifications.remaining('c1')).toBe(5);
  });
});

// The plan's acceptance criterion: "The send rides state.tail behind a
// preceding narration." Unit tests prove each link; this proves the seam, by
// wiring the real send_file tool to the real service with a sink shaped like
// remoteHostSubscriptions.ts (imagePath -> controller.deliverHostImage ->
// progress.deliverImage). A regression in how the two halves are joined -- the
// sink ignoring imagePath, or deliverFile bypassing the fan-out -- fails only
// here.
describe('send_file through the remote delivery chain', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    (
      vscode.workspace as unknown as { workspaceFolders: unknown }
    ).workspaceFolders = undefined;
  });

  it('queues the file behind the narration that preceded it', async () => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-send-file-chain-'));
    setWorkspace(dir);
    const file = path.join(dir, 'plan.md');
    fs.writeFileSync(file, '# plan\n');

    const { channel, progress } = progressRig();
    // Record what the channel sees, in order: the point of this test is that
    // the queued file send lands BEHIND the narration that preceded it.
    const order: string[] = [];
    const sendPhoto = channel.sendPhoto.bind(channel);
    channel.sendPhoto = async (chatId, filePath, caption) => {
      order.push(`photo:${path.basename(filePath)}:${caption}`);
      await sendPhoto(chatId, filePath, caption);
    };
    const send = channel.send.bind(channel);
    channel.send = async (chatId, text, options) => {
      order.push(`text:${text}`);
      await send(chatId, text, options);
    };
    progress.begin('c1', 'chat-a', 'message-1');

    // Mirrors remoteHostSubscriptions.ts: an imagePath routes to the photo
    // path; a plain notification would go to controller.enqueueHostNotification.
    // send_file always sets imagePath, so only that arm is exercised here.
    const notifications = new UserNotificationService();
    notifications.addSink(async (event) =>
      event.conversationId && event.imagePath
        ? progress.deliverImage(event.conversationId, event.imagePath, event.text)
        : 0,
    );

    const tool = makeSendFileTool({ notifications });
    // Narration first, exactly as a real turn emits it before the tool runs.
    progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Sending the plan now.' });
    const result = await tool.handler(
      { path: file, caption: 'the plan doc' },
      { beforeMutate: () => undefined, conversationId: 'c1' },
    );

    expect(result).toContain('Queued plan.md for 1 remote chat(s).');
    await vi.advanceTimersByTimeAsync(1_000);
    // The seam this test exists for: the file send goes out AFTER the narration
    // that preceded it, because both ride the same per-turn tail.
    expect(order).toEqual(['text:Sending the plan now.', 'photo:plan.md:the plan doc']);
    // Path identity, not just a name that happens to match: basename plus
    // existence would also pass if the sink had picked a DIFFERENT existing
    // plan.md. Windows hands back either the long-name or the 8.3 short-name
    // spelling of a temp path depending on the call, so the comparison is done
    // on realpaths rather than on the raw strings.
    expect(channel.photos).toHaveLength(1);
    const sent = channel.photos[0]!;
    expect(sent.chatId).toBe('chat-a');
    expect(sent.caption).toBe('the plan doc');
    expect(fs.realpathSync.native(sent.filePath)).toBe(fs.realpathSync.native(file));
    expect(fs.readFileSync(sent.filePath, 'utf8')).toBe('# plan\n');
  });
});

describe('sendTelegramPhoto', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function imageFile(bytes: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tg-photo-'));
    dirs.push(dir);
    const file = path.join(dir, 'fox.jpg');
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
    return file;
  }

  function recordingFetch(statuses: Record<string, number>) {
    const methods: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const method = String(url).split('/').pop() ?? '';
      methods.push(method);
      return new Response('{}', { status: statuses[method] ?? 200 });
    }) as unknown as typeof fetch;
    return { methods, fetchImpl };
  }

  it('sends a photo when Telegram accepts it', async () => {
    const { methods, fetchImpl } = recordingFetch({});
    await sendTelegramPhoto(fetchImpl, 't', new TelegramChatQueue(), '1', imageFile(10), 'fox');
    expect(methods).toEqual(['sendPhoto']);
  });

  it('falls back to a document when sendPhoto rejects the image', async () => {
    const { methods, fetchImpl } = recordingFetch({ sendPhoto: 400 });
    await sendTelegramPhoto(fetchImpl, 't', new TelegramChatQueue(), '1', imageFile(10), 'fox');
    expect(methods).toEqual(['sendPhoto', 'sendDocument']);
  });

  it('goes straight to a document above the photo size limit', async () => {
    const { methods, fetchImpl } = recordingFetch({});
    const big = imageFile(TELEGRAM_MAX_PHOTO_BYTES + 1);
    await sendTelegramPhoto(fetchImpl, 't', new TelegramChatQueue(), '1', big, 'fox');
    expect(methods).toEqual(['sendDocument']);
  });

  it('goes straight to a document for a non-image extension, never calling sendPhoto', async () => {
    // sendPhoto cannot accept a .md/.pdf/.txt, so attempting it first is a
    // guaranteed 400 plus a wasted round trip on the per-chat send queue. The
    // photo path for real images is unchanged (see the .jpg tests above).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tg-photo-'));
    dirs.push(dir);
    const file = path.join(dir, 'plan.md');
    fs.writeFileSync(file, '# plan\n');
    const { methods, fetchImpl } = recordingFetch({ sendPhoto: 400 });
    await sendTelegramPhoto(fetchImpl, 't', new TelegramChatQueue(), '1', file, 'plan');
    expect(methods).toEqual(['sendDocument']);
  });

  it('throws on a non-400 failure instead of retrying as a document', async () => {
    const { methods, fetchImpl } = recordingFetch({ sendPhoto: 401 });
    await expect(
      sendTelegramPhoto(fetchImpl, 't', new TelegramChatQueue(), '1', imageFile(10), 'fox'),
    ).rejects.toThrow(/sendPhoto HTTP 401/);
    expect(methods).toEqual(['sendPhoto']);
  });
});
