import { describe, expect, it } from 'vitest';
import { inNewChatPrologueLock } from '../../src/sidebar/newChatPrologue';

/**
 * The lock both openers of a chat take: the agent bus's `--new`
 * (`src/vscode/agentBusSubmission.ts`) and `message_chat action=new`
 * (`src/tools/messageChatNewChat.ts`). Its whole job is that a create and its
 * pin stay together, so these tests are about ordering, not about what happens
 * inside — and about the one thing a lock can get wrong: a failure that leaves
 * everybody else waiting behind it.
 */
describe('new-chat prologue lock', () => {
  it('keeps two prologues from interleaving', async () => {
    const order: string[] = [];
    const slow = inNewChatPrologueLock(async () => {
      order.push('first:read');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first:pin');
      return 'first';
    });
    const second = inNewChatPrologueLock(async () => {
      order.push('second:read');
      order.push('second:pin');
      return 'second';
    });
    expect(await Promise.all([slow, second])).toEqual(['first', 'second']);
    // The second opener may not even look until the first has pinned, or it
    // would follow the model the first had just put on a chat nobody meant.
    expect(order).toEqual(['first:read', 'first:pin', 'second:read', 'second:pin']);
  });

  it('lets the next open through after a failed one', async () => {
    const failed = inNewChatPrologueLock(async () => {
      throw new Error('all chat slots are occupied');
    });
    await expect(failed).rejects.toThrow('all chat slots are occupied');
    // A chat cap or an unknown model is a refusal the sender acts on, not a
    // reason to make every later open wait behind a broken promise.
    await expect(inNewChatPrologueLock(async () => 'open')).resolves.toBe('open');
  });

  it('runs a prologue that is rejected before it starts', async () => {
    // `then(run, run)` is deliberate: a line already broken must not swallow the
    // next opener's turn at the lock.
    const poison = Promise.reject(new Error('earlier failure'));
    const held = inNewChatPrologueLock(async () => 'mine');
    void poison.catch(() => undefined);
    expect(await held).toBe('mine');
  });
});
