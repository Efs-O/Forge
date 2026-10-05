import { describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAgentProgress, CLOCK_INTERVAL_MS } from '../../src/remote/RemoteAgentProgress';
import { RemoteDraftRegistry } from '../../src/remote/RemoteDraftRegistry';
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
  it('stops streaming to a chat switched to another conversation mid-turn', async () => {
    const channel = new FakeRemoteChannel();
    const signal = new AbortController().signal;
    const progress = new RemoteAgentProgress(channel, signal, () => true, 3_900, 0);
    let chatId: string | undefined = 'chat-1';
    const opener = new HostProgressOpener({ channel, signal, progress, target: () => chatId });
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
    const opener = new HostProgressOpener({ channel, signal, progress, target: () => chatId });
    opener.handle(status('Running tests…'));
    await settle();

    chatId = 'chat-2';
    opener.handle(status('Running build…'));
    await settle();
    expect(channel.progress.map((sent) => sent.chatId)).toEqual(['chat-1', 'chat-2']);
    expect(channel.edits.at(-1)?.chatId).toBe('chat-2');
    expect(channel.edits.at(-1)?.text).toContain('Running build…');
  });

  it('does not adopt a mirrored draft that opens after the pairing was revoked', async () => {
    // The same unpair race on the mirror lane: a sidebar-started turn opens its
    // preview over an await, and the pairing can be revoked inside it. The
    // returned id must not reach the registry, or a Stop on that preview would
    // cancel a turn the revoked owner no longer has any claim on.
    const channel = new FakeRemoteChannel();
    const signal = new AbortController().signal;
    const drafts = new RemoteDraftRegistry();
    const progress = new RemoteAgentProgress(
      channel,
      signal,
      () => true,
      3_900,
      0,
      undefined,
      undefined,
      CLOCK_INTERVAL_MS,
      drafts,
    );
    let openDraft!: (draftId: number) => void;
    const openGate = new Promise<number>((resolve) => (openDraft = resolve));
    let openStarted = false;
    let opens = 0;
    channel.richDraft = {
      beginDraft: async () => {
        opens += 1;
        if (opens === 1) openStarted = true;
        // Telegram hands out a fresh id per preview, so a later open is never
        // the revoked one arriving again.
        return { kind: 'open', draftId: opens === 1 ? await openGate : 78 };
      },
      updateDraft: async () => undefined,
      finalizeStatus: async () => 'final-1',
    };
    const opener = new HostProgressOpener({
      channel,
      signal,
      progress,
      target: () => 'chat-1',
      draftEpoch: drafts,
    });

    opener.handle(status('Running tests…'));
    await vi.waitFor(() => expect(openStarted).toBe(true));
    drafts.forgetAll();
    openDraft(77);
    await settle();

    expect(drafts.size).toBe(0);
    expect(drafts.find('chat-1', 77)).toBeUndefined();
    expect(progress.has('c1')).toBe(false);
    // Not latched as declined: pairing is re-checked per event, so a chat paired
    // again later in the turn must still get a bubble of its own.
    opener.handle(status('Still running…'));
    await settle();
    expect(progress.has('c1')).toBe(true);
    // The revoked id stays unclaimed; the fresh preview is the only live one.
    expect(drafts.find('chat-1', 77)).toBeUndefined();
    expect(drafts.find('chat-1', 78)?.conversationId).toBe('c1');
    expect(drafts.size).toBe(1);
  });

  it('opens no plain bubble for a revoked pairing whose draft came back unsupported', async () => {
    // Same fallback branch on the mirror lane. The draft refusal arrives after
    // the revocation, so falling through to `sendProgress` would create a new
    // progress message in a chat that no longer has an owner. Unlike a preview,
    // a plain bubble never expires on its own.
    const channel = new FakeRemoteChannel();
    const signal = new AbortController().signal;
    const drafts = new RemoteDraftRegistry();
    const progress = new RemoteAgentProgress(
      channel,
      signal,
      () => true,
      3_900,
      0,
      undefined,
      undefined,
      CLOCK_INTERVAL_MS,
      drafts,
    );
    let resolveUnsupported!: () => void;
    const unsupportedGate = new Promise<void>((resolve) => (resolveUnsupported = resolve));
    let openStarted = false;
    channel.richDraft = {
      beginDraft: async () => {
        openStarted = true;
        await unsupportedGate;
        return { kind: 'unsupported' };
      },
      updateDraft: async () => undefined,
      finalizeStatus: async () => 'final-1',
    };
    const opener = new HostProgressOpener({
      channel,
      signal,
      progress,
      target: () => 'chat-1',
      draftEpoch: drafts,
    });

    opener.handle(status('Running tests…'));
    await vi.waitFor(() => expect(openStarted).toBe(true));
    drafts.forgetAll();
    resolveUnsupported();
    await settle();

    expect(channel.progress).toEqual([]);
    expect(progress.has('c1')).toBe(false);
    expect(drafts.size).toBe(0);
  });

  it('still falls back to a plain bubble when the draft is unsupported and nothing was revoked', async () => {
    // The guard must not swallow the ordinary fallback: with an epoch-aware
    // opener but no revocation, an unsupported draft still gets exactly one
    // plain progress bubble.
    const channel = new FakeRemoteChannel();
    const signal = new AbortController().signal;
    const drafts = new RemoteDraftRegistry();
    const progress = new RemoteAgentProgress(
      channel,
      signal,
      () => true,
      3_900,
      0,
      undefined,
      undefined,
      CLOCK_INTERVAL_MS,
      drafts,
    );
    channel.richDraft = {
      beginDraft: async () => ({ kind: 'unsupported' }),
      updateDraft: async () => undefined,
      finalizeStatus: async () => 'final-1',
    };
    const opener = new HostProgressOpener({
      channel,
      signal,
      progress,
      target: () => 'chat-1',
      draftEpoch: drafts,
    });
    opener.handle(status('Running tests…'));
    await settle();
    expect(channel.progress).toEqual([{ chatId: 'chat-1', text: 'Forge: working…' }]);
  });
});
