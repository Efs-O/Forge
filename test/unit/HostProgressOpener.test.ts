import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';
import { HostProgressOpener } from '../../src/remote/remoteHostProgress';
import type { AgentProgressEvent } from '../../src/sidebar/AgentProgress';

afterEach(() => {
  vi.useRealTimers();
});

function rig(options: {
  target?: string | undefined;
  separateStopControl?: boolean;
  canDeliver?: () => Promise<boolean>;
  enqueuePrompt?: (chatId: string, text: string) => Promise<void>;
} = {}) {
  const channel = new FakeRemoteChannel();
  if (options.separateStopControl) {
    const controllable = channel as FakeRemoteChannel & {
      sendProgressStopControl: (chatId: string) => Promise<string>;
    };
    controllable.sendProgressStopControl = async (chatId) => {
      channel.progress.push({ chatId, text: '\u2063' });
      const messageId = String(channel.progress.length);
      channel.stopButtons.add(messageId);
      return messageId;
    };
  }
  const signal = new AbortController().signal;
  const progress = new RemoteAgentProgress(channel, signal, () => true, 3_900, 0);
  const opener = new HostProgressOpener({
    channel,
    signal,
    progress,
    target: () => ('target' in options ? options.target : 'chat-1'),
    canDeliver: options.canDeliver ?? (async () => true),
    enqueuePrompt: options.enqueuePrompt,
  });
  return { channel, progress, opener };
}

const status = (text: string): AgentProgressEvent => ({
  conversationId: 'c1',
  kind: 'status',
  text,
});

const token = (text: string): AgentProgressEvent => ({
  conversationId: 'c1',
  kind: 'commentary',
  text,
});

/** The rendered message settles one edit interval (0ms here) after an event. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('HostProgressOpener', () => {
  it('opens a message for a turn no chat queued, and shows its progress', async () => {
    const { channel, opener } = rig();
    opener.handle(token('I have strong evidence'));
    await settle();
    expect(channel.progress).toEqual([{ chatId: 'chat-1', text: 'Forge: working…' }]);
    opener.handle(status('Running tests…'));
    await settle();
    // The words stream into the bubble, with the status as its footer.
    expect(channel.edits.at(-1)?.text).toMatch(
      /^I have strong evidence\n\n⏳ Running tests…\n<1 min · 0 tool calls · active /,
    );
    expect(channel.stopButtons.has('1')).toBe(true);
  });

  it('holds the events streamed before the message exists, rather than losing them', async () => {
    const { channel, opener } = rig();
    // Both land while the opening sendProgress is still in flight.
    opener.handle(token('first'));
    opener.handle(status('Running read_file…'));
    await settle();
    expect(channel.progress).toHaveLength(1);
    expect(channel.edits.at(-1)?.text).toContain('Running read_file…');
  });

  it('closes the message when the turn ends', async () => {
    const { channel, opener } = rig();
    opener.handle(token('working on it'));
    await settle();
    opener.handle({ conversationId: 'c1', kind: 'end', ok: true });
    await settle();
    expect(channel.edits.at(-1)?.text).toBe('Forge: completed.');
  });

  it('keeps the separate Stop row above a mirrored turn and deletes it at end', async () => {
    const { channel, opener } = rig({ separateStopControl: true });
    opener.handle(token('I have strong evidence'));
    await settle();

    expect(channel.progress.map((message) => message.text)).toEqual([
      '\u2063',
      'Forge: working…',
    ]);
    expect(channel.stopButtons.has('1')).toBe(true);
    expect(channel.stopButtons.has('2')).toBe(false);

    opener.handle({ conversationId: 'c1', kind: 'end', ok: true });
    await settle();

    expect(channel.deleted).toContainEqual({ chatId: 'chat-1', messageId: '1' });
  });

  it('reports a failed turn as failed', async () => {
    const { channel, opener } = rig();
    opener.handle(token('working on it'));
    await settle();
    opener.handle({ conversationId: 'c1', kind: 'end', ok: false });
    await settle();
    expect(channel.edits.at(-1)?.text).toBe('Forge: failed.');
  });

  it('sends nothing for an unpaired conversation, however many tokens stream', async () => {
    const { channel, opener } = rig({ target: undefined });
    for (let index = 0; index < 20; index += 1) opener.handle(token(`t${String(index)}`));
    await settle();
    for (let index = 0; index < 20; index += 1) opener.handle(token(`u${String(index)}`));
    await settle();
    expect(channel.progress).toHaveLength(0);
    expect(channel.edits).toHaveLength(0);
  });

  it('reconsiders on the next turn after a turn nobody was listening to', async () => {
    const channel = new FakeRemoteChannel();
    const signal = new AbortController().signal;
    const progress = new RemoteAgentProgress(channel, signal, () => true, 3_900, 0);
    let chatId: string | undefined;
    const opener = new HostProgressOpener({
      channel,
      signal,
      progress,
      target: () => chatId,
      canDeliver: async () => true,
    });
    opener.handle(token('unheard'));
    await settle();
    opener.handle({ conversationId: 'c1', kind: 'end', ok: true });
    await settle();
    expect(channel.progress).toHaveLength(0);

    chatId = 'chat-2';
    opener.handle(token('heard'));
    await settle();
    expect(channel.progress).toEqual([{ chatId: 'chat-2', text: 'Forge: working…' }]);
  });

  it('starts watching mid-turn when a chat is paired after the turn began', async () => {
    const channel = new FakeRemoteChannel();
    const signal = new AbortController().signal;
    const progress = new RemoteAgentProgress(channel, signal, () => true, 3_900, 0);
    let chatId: string | undefined;
    const opener = new HostProgressOpener({ channel, signal, progress, target: () => chatId, canDeliver: async () => true });
    opener.handle(token('before pairing'));
    await settle();
    expect(channel.progress).toHaveLength(0);

    chatId = 'chat-3';
    opener.handle(token('after pairing'));
    await settle();
    expect(channel.progress).toEqual([{ chatId: 'chat-3', text: 'Forge: working…' }]);
  });

  it('leaves a chat-queued turn to the queue drain that opened it', async () => {
    const { channel, progress, opener } = rig();
    progress.begin('c1', 'chat-1', 'msg-7');
    opener.handle(status('streaming'));
    await settle();
    // No second message: the drain's own is edited instead.
    expect(channel.progress).toHaveLength(0);
    expect(channel.edits.at(-1)?.messageId).toBe('msg-7');
    // And the turn's `end` must not close it -- only the request's outcome does,
    // because a cancelled request also ends its turn without failing.
    opener.handle({ conversationId: 'c1', kind: 'end', ok: true });
    await settle();
    expect(progress.owns('c1')).toBe(true);
  });

  it('opens no progress message while the chat is locked and holds the prompt until the turn ends', async () => {
    const queued: Array<{ chatId: string; text: string }> = [];
    const { channel, opener } = rig({
      canDeliver: async () => false,
      enqueuePrompt: async (chatId, text) => queued.push({ chatId, text }),
    });
    opener.stashPrompt('c1', 'chat-1', 'You (VS Code): hello');
    opener.handle(token('private while locked'));
    await settle();
    expect(channel.progress).toEqual([]);

    opener.handle({ conversationId: 'c1', kind: 'end', ok: true });
    await settle();
    expect(queued).toEqual([{ chatId: 'chat-1', text: 'You (VS Code): hello' }]);
  });

  it('sends a held prompt before the first working status', async () => {
    const { channel, opener } = rig();
    const promptChannel = channel as FakeRemoteChannel & {
      sendProgressPrompt: (chatId: string, text: string) => Promise<string>;
    };
    promptChannel.sendProgressPrompt = async (chatId, text) => {
      channel.progress.push({ chatId, text });
      return 'prompt-id';
    };
    opener.stashPrompt('c1', 'chat-1', 'You (VS Code): hello');

    opener.handle(token('first progress event'));
    await settle();

    expect(channel.progress.map((message) => message.text)).toEqual([
      'You (VS Code): hello',
      'Forge: working…',
    ]);
  });

  it('rechecks a locked chat after ten seconds and opens on the next event', async () => {
    vi.useFakeTimers();
    let deliverable = false;
    const canDeliver = vi.fn(async () => deliverable);
    const { channel, progress, opener } = rig({ canDeliver });
    try {
      opener.handle(token('first event while locked'));
      await vi.advanceTimersByTimeAsync(0);
      opener.handle(token('second event inside cooldown'));
      await vi.advanceTimersByTimeAsync(0);
      expect(canDeliver).toHaveBeenCalledTimes(1);
      expect(channel.progress).toEqual([]);

      deliverable = true;
      vi.setSystemTime(Date.now() + 10_001);
      opener.handle(token('event after unlock'));
      await vi.advanceTimersByTimeAsync(0);
      expect(canDeliver).toHaveBeenCalledTimes(2);
      expect(channel.progress).toEqual([{ chatId: 'chat-1', text: 'Forge: working…' }]);
    } finally {
      opener.dispose();
      await progress.dispose();
    }
  });
  it('stops streaming to a chat switched to another conversation mid-turn', async () => {
    const channel = new FakeRemoteChannel();
    const signal = new AbortController().signal;
    const progress = new RemoteAgentProgress(channel, signal, () => true, 3_900, 0);
    let chatId: string | undefined = 'chat-1';
    const opener = new HostProgressOpener({ channel, signal, progress, target: () => chatId, canDeliver: async () => true });
    opener.handle(status('Running tests…'));
    await settle();
    expect(channel.progress).toHaveLength(1);

    chatId = undefined; // the chat now follows a different conversation
    opener.handle(status('Running build…'));
    await settle();
    expect(channel.edits.at(-1)?.text).toContain('stopped following this turn');
    const editsAfterStop = channel.edits.length;
    opener.handle(status('Still running…'));
    opener.handle({ conversationId: 'c1', kind: 'end', ok: true });
    await settle();
    expect(channel.edits).toHaveLength(editsAfterStop);
    expect(channel.progress).toHaveLength(1);
  });

  it('moves to the chat that now follows the conversation', async () => {
    const channel = new FakeRemoteChannel();
    const signal = new AbortController().signal;
    const progress = new RemoteAgentProgress(channel, signal, () => true, 3_900, 0);
    let chatId = 'chat-1';
    const opener = new HostProgressOpener({ channel, signal, progress, target: () => chatId, canDeliver: async () => true });
    opener.handle(status('Running tests…'));
    await settle();

    chatId = 'chat-2';
    opener.handle(status('Running build…'));
    await settle();
    expect(channel.progress.map((sent) => sent.chatId)).toEqual(['chat-1', 'chat-2']);
    expect(channel.edits.at(-1)?.chatId).toBe('chat-2');
    expect(channel.edits.at(-1)?.text).toContain('Running build…');
  });
});
