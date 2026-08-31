import { describe, expect, it, vi } from 'vitest';
import {
  NOTIFY_TURN_LIMIT,
  UserNotificationService,
} from '../../src/sidebar/UserNotificationService';
import { makeNotifyUserTool } from '../../src/tools/uxTools';

describe('UserNotificationService', () => {
  it('sums the chat counts reported by every sink', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 2);
    service.addSink(async () => 1);
    expect(await service.notify({ conversationId: 'c1', text: 'hi' })).toBe(3);
  });

  it('reports zero when nothing is bound', async () => {
    const service = new UserNotificationService();
    expect(await service.notify({ conversationId: 'c1', text: 'hi' })).toBe(0);
  });

  // One broken transport must not take down a notification the other sinks --
  // and the unconditional VS Code toast -- can still deliver.
  it('counts a throwing sink as zero, reports it, and does not reject', async () => {
    const onSinkError = vi.fn();
    const service = new UserNotificationService(onSinkError);
    service.addSink(async () => {
      throw new Error('transport down');
    });
    service.addSink(async () => 4);
    expect(await service.notify({ conversationId: 'c1', text: 'hi' })).toBe(4);
    expect(onSinkError).toHaveBeenCalledOnce();
    expect(onSinkError.mock.calls[0]?.[0]).toContain('transport down');
  });

  it('stops offering budget after the per-turn limit', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      expect(service.remaining('c1')).toBeGreaterThan(0);
      await service.notify({ conversationId: 'c1', text: `m${i}` });
    }
    expect(service.remaining('c1')).toBe(0);
  });

  it('budgets each conversation separately', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      await service.notify({ conversationId: 'c1', text: 'm' });
    }
    expect(service.remaining('c1')).toBe(0);
    expect(service.remaining('c2')).toBe(NOTIFY_TURN_LIMIT);
  });

  // Reset happens on turn START. A turn that throws or is cancelled never
  // reaches its end, so an end-keyed counter would leak and silently mute the
  // agent for every later turn in that conversation.
  it('clears the budget when the next turn starts', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      await service.notify({ conversationId: 'c1', text: 'm' });
    }
    expect(service.remaining('c1')).toBe(0);
    service.resetTurn('c1');
    expect(service.remaining('c1')).toBe(NOTIFY_TURN_LIMIT);
    expect(await service.notify({ conversationId: 'c1', text: 'again' })).toBe(1);
  });

  // PromptRun fires onGenerationStarted with no conversationId -- a /compact
  // summary is not the user's turn and must not refill a real turn's budget.
  it('does not clear a conversation budget on a conversation-less turn start', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      await service.notify({ conversationId: 'c1', text: 'm' });
    }
    service.resetTurn(undefined);
    expect(service.remaining('c1')).toBe(0);
  });

  it('stops fanning out to a disposed sink', async () => {
    const service = new UserNotificationService();
    const subscription = service.addSink(async () => 5);
    expect(await service.notify({ conversationId: 'c1', text: 'a' })).toBe(5);
    subscription.dispose();
    expect(await service.notify({ conversationId: 'c1', text: 'b' })).toBe(0);
  });
});

describe('notify_user tool', () => {
  it('names the remote chats it reached', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 2);
    const tool = makeNotifyUserTool(service);
    const result = await tool.handler({ message: 'build done' }, ctx('c1'));
    expect(result).toBe('Message delivered to the VS Code window and 2 remote chat(s).');
  });

  // The ask_user lesson: a tool that reports success into a void teaches the
  // model to claim it notified a user whose phone never buzzed.
  it('states plainly that nothing reached the user remotely', async () => {
    const service = new UserNotificationService();
    const tool = makeNotifyUserTool(service);
    const result = await tool.handler({ message: 'build done' }, ctx('c1'));
    expect(result).toContain('did NOT receive it on their phone');
    expect(result).toContain('Do not claim you notified them remotely');
  });

  it('refuses past the per-turn cap and names the alternative', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    const tool = makeNotifyUserTool(service);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      await tool.handler({ message: `m${i}` }, ctx('c1'));
    }
    const capped = await tool.handler({ message: 'one too many' }, ctx('c1'));
    expect(capped).toContain(`Notification limit reached for this turn (${NOTIFY_TURN_LIMIT})`);
    expect(capped).toContain('put it in your final reply instead');
  });

  it('does not consume budget for a call it refused', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    const tool = makeNotifyUserTool(service);
    for (let i = 0; i < NOTIFY_TURN_LIMIT + 3; i += 1) {
      await tool.handler({ message: 'm' }, ctx('c1'));
    }
    service.resetTurn('c1');
    expect(await tool.handler({ message: 'fresh turn' }, ctx('c1'))).toContain('delivered');
  });

  it('takes no free-form blob arg', () => {
    const schema = makeNotifyUserTool(new UserNotificationService()).definition.function.parameters;
    expect(schema).toMatchObject({
      required: ['message'],
      additionalProperties: false,
    });
    expect(Object.keys((schema as { properties: object }).properties)).toEqual(['message']);
  });
});

function ctx(conversationId: string) {
  return { beforeMutate: () => {}, conversationId };
}
