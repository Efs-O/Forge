import { describe, expect, it } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';

function rig(): {
  channel: FakeRemoteChannel & {
    removeProgressStopKeyboard: (chatId: string) => Promise<void>;
  };
  removed: string[];
  progress: RemoteAgentProgress;
} {
  const channel = new FakeRemoteChannel('telegram') as FakeRemoteChannel & {
    removeProgressStopKeyboard: (chatId: string) => Promise<void>;
  };
  const removed: string[] = [];
  channel.removeProgressStopKeyboard = async (chatId) => {
    removed.push(chatId);
  };
  const progress = new RemoteAgentProgress(channel, new AbortController().signal, () => true, 3_900, 0);
  return { channel, removed, progress };
}

describe('RemoteAgentProgress Stop keyboard lifecycle', () => {
  it.each([
    ['completed', 'Forge: completed.'],
    ['failed', 'Forge: failed.'],
    ['cancelled', 'Forge: cancelled.'],
  ] as const)('removes and deletes a control carrier on %s', async (_outcome, terminal) => {
    const { channel, removed, progress } = rig();
    progress.begin('c1', 'chat-1', 'status-id', 'remote', 'control-id');

    await progress.finish('c1', terminal);

    expect(removed).toEqual(['chat-1']);
    expect(channel.deleted).toContainEqual({ chatId: 'chat-1', messageId: 'control-id' });
  });

  it('removes the prompt carrier keyboard but keeps the prompt message', async () => {
    const { channel, removed, progress } = rig();
    progress.begin('c1', 'chat-1', 'status-id', 'host', 'prompt-id', false);

    await progress.finish('c1', 'Forge: completed.');

    expect(removed).toEqual(['chat-1']);
    expect(channel.deleted).not.toContainEqual({ chatId: 'chat-1', messageId: 'prompt-id' });
  });

  it('removes and deletes the control carrier on dispose', async () => {
    const { channel, removed, progress } = rig();
    progress.begin('c1', 'chat-1', 'status-id', 'remote', 'control-id');

    await progress.dispose();

    expect(removed).toEqual(['chat-1']);
    expect(channel.deleted).toContainEqual({ chatId: 'chat-1', messageId: 'control-id' });
  });
});
