import { describe, expect, it, vi } from 'vitest';
import { MAX_WAIT_SECONDS, makeWaitTool } from '../../src/tools/waitTool';
import { AgentInbox } from '../../src/agentBus/agentInbox';
import { MidTurnTellDrain } from '../../src/agent/MidTurnTellDrain';
import { MidTurnInbox } from '../../src/agent/MidTurnInbox';
import { localTimeOfDay } from '../../src/util/localClock';

const tool = makeWaitTool();
const ctx = (signal?: AbortSignal, tellArrived?: (callback: () => void) => () => void) => ({
  beforeMutate: () => {},
  ...(signal ? { abortSignal: signal } : {}),
  ...(tellArrived ? { tellArrived, conversationId: 'chat' } : {}),
});

describe('wait tool', () => {
  it('waits about as long as asked and reports the measured time', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
      const pending = tool.handler({ seconds: 1 }, ctx());
      let settled = false;
      void pending.then(() => (settled = true));

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatch(/^Waited 1s\. Local time is now \d{2}:\d{2}\.$/u);
      expect(Date.now()).toBe(Date.parse('2026-01-01T12:00:01Z'));
    } finally {
      vi.useRealTimers();
    }
  });

  // /stop must not leave a turn parked on a timer.
  it('returns as soon as the turn is aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = tool.handler({ seconds: MAX_WAIT_SECONDS }, ctx(controller.signal));
    try {
      await vi.advanceTimersByTimeAsync(50);
      controller.abort();
      await expect(pending).resolves.toContain('Wait cancelled after 0s');
      await expect(pending).resolves.toContain(`of the ${MAX_WAIT_SECONDS}s requested`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends early when a claimable agent-bus message arrives for this conversation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
    const { inbox, drain, registerSource } = busWaitFixture({ unattended: false });
    try {
      const pending = tool.handler({ seconds: 30 }, ctx(undefined, (callback) =>
        drain.onArrived('chat', callback),
      ));
      await vi.advanceTimersByTimeAsync(2_500);
      registerSource();
      inbox.accept('new bus message', 'claude', false, { targetConversationId: 'chat' });
      await expect(pending).resolves.toBe(
        `Wait ended after 3s of the 30s requested because a new message arrived. Local time is now ${localTimeOfDay()}.`,
      );
    } finally {
      inbox.dispose();
      vi.useRealTimers();
    }
  });

  it.each([
    ['another conversation', { targetConversationId: 'other' }, { unattended: false }, false],
    ['a held message before release', { targetConversationId: 'chat', hold: true }, { unattended: false }, true],
    ['an unattended message in an attended turn', { targetConversationId: 'chat', unattended: true }, { unattended: false }, false],
  ] as const)(
    'does not end early for %s',
    async (_case, options, runningTurn, releaseAfterWait) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
      const { inbox, drain, accept, registerSource } = busWaitFixture(runningTurn);
      try {
        registerSource();
        const pending = tool.handler({ seconds: 30 }, ctx(undefined, (callback) =>
          drain.onArrived('chat', callback),
        ));
        await vi.advanceTimersByTimeAsync(2_000);
        const accepted = accept(options);
        await vi.advanceTimersByTimeAsync(2_000);
        if (releaseAfterWait) {
          let settled = false;
          void pending.then(() => (settled = true));
          expect(settled).toBe(false);
          inbox.release(accepted.id);
          await expect(pending).resolves.toBe(
            `Wait ended after 4s of the 30s requested because a new message arrived. Local time is now ${localTimeOfDay()}.`,
          );
        } else {
          let settled = false;
          void pending.then(() => (settled = true));
          await Promise.resolve();
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(26_000);
          await expect(pending).resolves.toBe(
            `Waited 30s. Local time is now ${localTimeOfDay()}.`,
          );
        }
      } finally {
        inbox.dispose();
        vi.useRealTimers();
      }
    },
  );

  it('still ends early when a typed sidebar message arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
    const sidebarInbox = new MidTurnInbox();
    const drain = new MidTurnTellDrain();
    drain.registerSource(
      'sidebar',
      async (conversationId) => ({
        messages: sidebarInbox.drain(conversationId).map((tell) => ({ role: 'user', content: tell.text })),
      }),
      (conversationId, callback) => sidebarInbox.onAdded(conversationId, callback),
    );
    try {
      const pending = tool.handler({ seconds: 30 }, ctx(undefined, (callback) =>
        drain.onArrived('chat', callback),
      ));
      await vi.advanceTimersByTimeAsync(2_000);
      sidebarInbox.add('chat', { id: 'typed-1', text: 'typed message' });
      await expect(pending).resolves.toBe(
        `Wait ended after 2s of the 30s requested because a new message arrived. Local time is now ${localTimeOfDay()}.`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns immediately when the turn is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    const result = await tool.handler({ seconds: MAX_WAIT_SECONDS }, ctx(controller.signal));
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result).toContain('Wait cancelled');
  });

  it('rejects invalid values and clamps an overlong wait with a visible note', async () => {
    await expect(tool.handler({ seconds: 0 }, ctx())).rejects.toThrow(
      new RegExp(`1 to ${MAX_WAIT_SECONDS}`, 'u'),
    );
    await expect(tool.handler({ seconds: 1.5 }, ctx())).rejects.toThrow(/whole number/u);
    const controller = new AbortController();
    const pending = tool.handler({ seconds: MAX_WAIT_SECONDS + 1 }, ctx(controller.signal));
    controller.abort();
    await expect(pending).resolves.toContain(`seconds clamped to ${MAX_WAIT_SECONDS}`);
  });

  it('takes no free-form blob arg', () => {
    const schema = tool.definition.function.parameters;
    expect(schema).toMatchObject({ required: ['seconds'], additionalProperties: false });
    expect(Object.keys((schema as { properties: object }).properties)).toEqual(['seconds']);
  });

  it('points at monitor_execution for waiting on a command', () => {
    expect(tool.definition.function.description).toContain('monitor_execution');
  });

  // The 2026-09-05 miscount: two wait(360) calls reported as a 60-minute check.
  // A duration alone gives no position in time, so the model can only count its
  // own sleeps, and it cannot see a miscount from the inside.
  it('reports the wall clock so an interval can be timed against it', () => {
    expect(tool.definition.function.description).toContain('local wall-clock time');
    expect(tool.definition.function.description).toContain(`an hour is four calls of ${MAX_WAIT_SECONDS}s`);
  });
});

function busWaitFixture(runningTurn: { unattended: boolean; jobId?: string }): {
  inbox: AgentInbox;
  drain: MidTurnTellDrain;
  accept(options: { targetConversationId?: string; hold?: boolean; unattended?: boolean }): { id: string };
  registerSource(): void;
} {
  const inbox = new AgentInbox(
    {
      isBusy: () => true,
      laneOf: (options) => options?.targetConversationId ?? 'chat',
      submit: async () => ({ kind: 'completed' }),
      warn: () => {},
    },
    60_000,
  );
  const drain = new MidTurnTellDrain();
  const targetOf = (options?: { targetConversationId?: string }): string =>
    options?.targetConversationId ?? 'chat';
  const turnPolicy = (): typeof runningTurn => runningTurn;
  return {
    inbox,
    drain,
    registerSource: () =>
      drain.registerSource(
        'agent-bus',
        async (conversationId) => ({
          messages: inbox.claimMidTurn(conversationId, targetOf, runningTurn).map((item) => ({
            role: 'user',
            content: item.content,
          })),
        }),
        (conversationId, callback) =>
          inbox.onClaimableMidTurnAdded(conversationId, targetOf, turnPolicy, callback),
      ),
    accept: (options) => {
      const accepted = inbox.accept('bus message', 'claude', false, options);
      if (!accepted) throw new Error('message was not accepted');
      return accepted;
    },
  };
}
