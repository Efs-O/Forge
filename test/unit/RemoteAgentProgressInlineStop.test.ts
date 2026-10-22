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

describe('RemoteAgentProgress inline Stop lifecycle (0.17.69)', () => {
  it.each([
    ['completed', 'Forge: completed.'],
    ['failed', 'Forge: failed.'],
    ['cancelled', 'Forge: cancelled.'],
  ] as const)('drops Stop from the status on %s and touches no keyboard', async (_outcome, terminal) => {
    const { channel, removed, progress } = rig();
    const status = await channel.sendProgress('chat-1', 'Forge: working…', { stopButton: true });
    progress.begin('c1', 'chat-1', status!, 'remote');
    expect(progress.conversationForBubble('chat-1', status!)).toBe('c1');

    await progress.finish('c1', terminal);

    expect(channel.stopButtons.has(status!)).toBe(false);
    expect(removed).toEqual([]);
    expect(channel.deleted).toEqual([]);
  });

  it('touches no keyboard and deletes nothing on dispose', async () => {
    const { channel, removed, progress } = rig();
    progress.begin('c1', 'chat-1', 'status-id', 'host');

    await progress.dispose();

    expect(removed).toEqual([]);
    expect(channel.deleted).toEqual([]);
  });
});
