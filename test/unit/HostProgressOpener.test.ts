import { describe, expect, it } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';
import { HostProgressOpener } from '../../src/remote/remoteHostProgress';
import type { AgentProgressEvent } from '../../src/sidebar/AgentProgress';

function rig(options: { target?: string | undefined } = {}) {
  const channel = new FakeRemoteChannel();
  const signal = new AbortController().signal;
  const progress = new RemoteAgentProgress(channel, signal, () => true, 3_900, 0);
  const opener = new HostProgressOpener({
    channel,
    signal,
    progress,
    target: () => ('target' in options ? options.target : 'chat-1'),
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
    expect(channel.edits.at(-1)?.text).toContain('Running tests…');
    // Streamed words never enter the bubble; they arrive as their own message.
    expect(channel.edits.at(-1)?.text).not.toContain('I have strong evidence');
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
    const opener = new HostProgressOpener({ channel, signal, progress, target: () => chatId });
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
});
