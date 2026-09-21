import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NOTIFY_IDLE_RESET_MS,
  NOTIFY_TURN_LIMIT,
  UserNotificationService,
} from '../../src/sidebar/UserNotificationService';
import { makeNotifyUserTool } from '../../src/tools/uxTools';
import { readOutboxItem, writeOutboxItem } from '../../src/jobs/JobOutbox';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';

const unattendedOutboxDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    unattendedOutboxDirs.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })),
  );
});

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

  it('writes an unattended notification to the job outbox', async () => {
    const service = new UserNotificationService();
    const outboxDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-unattended-'));
    unattendedOutboxDirs.push(outboxDir);
    const marker = unattendedConversations.mark('unattended-notification');
    try {
      const tool = makeNotifyUserTool(
        service,
        unattendedConversations,
        (conversationId, message) =>
          writeOutboxItem(outboxDir, conversationId, 'Llama job', message, 123),
      );
      const result = await tool.handler(
        { message: 'the install needs attention' },
        { beforeMutate: () => undefined, conversationId: 'unattended-notification' },
      );
      const item = await readOutboxItem(outboxDir, 'unattended-notification');
      expect(item?.text).toBe('the install needs attention');
      expect(result).toContain('job outbox');
    } finally {
      marker.dispose();
    }
  });

  it('refuses past the burst cap and names the alternative', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    const tool = makeNotifyUserTool(service);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      await tool.handler({ message: `m${i}` }, ctx('c1'));
    }
    const capped = await tool.handler({ message: 'one too many' }, ctx('c1'));
    expect(capped).toContain(`Notification limit reached: ${NOTIFY_TURN_LIMIT} sent`);
    expect(capped).toContain('put this message in your final reply instead');
    // The refusal has to say the budget comes back, or a paced run reads the
    // cap as final and goes silent for the rest of the turn.
    expect(capped).toContain('refills');
  });

  // The overnight-report failure: an 8-hour run is one turn, so a per-turn cap
  // with no refill silences a 2-hour cadence after its fourth report.
  it('returns the whole budget after a quiet stretch', async () => {
    let clock = 0;
    const service = new UserNotificationService(undefined, () => clock);
    service.addSink(async () => 1);
    const tool = makeNotifyUserTool(service);
    for (let i = 0; i < NOTIFY_TURN_LIMIT; i += 1) {
      await tool.handler({ message: `m${i}` }, ctx('c1'));
    }
    expect(service.remaining('c1')).toBe(0);

    // One second short of the window: still capped, and the refusal says how
    // much longer to wait rather than implying the turn must end first.
    clock += NOTIFY_IDLE_RESET_MS - 1000;
    const early = await tool.handler({ message: 'too soon' }, ctx('c1'));
    expect(early).toContain('Notification limit reached');
    expect(service.idleResetIn('c1')).toBe(1000);

    // A refused call must not push the window out, or a retrying agent could
    // never reach the reset it is waiting for.
    clock += 1000;
    expect(service.remaining('c1')).toBe(NOTIFY_TURN_LIMIT);
    expect(await tool.handler({ message: 'report 2' }, ctx('c1'))).toContain('delivered');
    // ...and the send that follows the reset starts a fresh burst, rather than
    // landing on the stale total and capping again immediately.
    expect(service.remaining('c1')).toBe(NOTIFY_TURN_LIMIT - 1);
  });

  it('reports remote reach without sending, and 0 when no probe is registered', () => {
    const service = new UserNotificationService();
    expect(service.reach('c1')).toBe(0);
    const registration = service.setReachProbe((id) => (id === 'c1' ? 2 : 0));
    expect(service.reach('c1')).toBe(2);
    expect(service.reach('c2')).toBe(0);
    expect(service.reach(undefined)).toBe(0);
    // Disposed with the transport: a count that outlived it would tell a turn
    // the user was reachable when nothing could deliver.
    registration.dispose();
    expect(service.reach('c1')).toBe(0);
  });

  it('reports reach 0 when the probe throws rather than failing the turn', () => {
    const service = new UserNotificationService();
    service.setReachProbe(() => {
      throw new Error('transport down');
    });
    expect(service.reach('c1')).toBe(0);
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
