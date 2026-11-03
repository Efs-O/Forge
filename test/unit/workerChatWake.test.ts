import { afterEach, describe, expect, it, vi } from 'vitest';
import { MidTurnInbox } from '../../src/agent/MidTurnInbox';
import {
  createSidebarPromptRouter,
  type SidebarPromptRouter,
} from '../../src/sidebar/backgroundExitNotice';
import type { MidTurnTellOrigin } from '../../src/agent/MidTurnInbox';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import { createWorkerChatWake } from '../../src/sidebar/workerChatWake';
import type { ForgeRequestOutcome } from '../../src/sidebar/turnOutcome';

const routers: SidebarPromptRouter[] = [];

function makeWake(reserved: boolean, openerOpen = true) {
  const inbox = new MidTurnInbox();
  let tellNumber = 0;
  const addTell = vi.fn(
    (
      id: string,
      text: string,
      internal?: boolean,
      tellId?: string,
      _createdAt?: number,
      origin?: Parameters<typeof inbox.add>[1]['origin'],
    ) => {
      tellNumber += 1;
      inbox.add(id, {
        id: tellId ?? `tell-${tellNumber}`,
        text,
        ...(internal ? { internal: true } : {}),
        ...(origin ? { origin } : {}),
      });
    },
  );
  const send = vi.fn(() => Promise.resolve<ForgeRequestOutcome>({ kind: 'completed', finalText: '' }));
  const router = createSidebarPromptRouter({
    activeId: () => 'active',
    isReserved: () => reserved,
    addTell,
    removeTell: () => false,
    markSendNow: () => false,
    isStreaming: () => false,
    interruptForSteering: async () => {},
    send,
    isOpen: () => openerOpen,
  });
  routers.push(router);
  const routeInternal = vi.fn(
    (text: string, id: string, origin: MidTurnTellOrigin) =>
      router.routeInternal(text, id, origin),
  );
  const logDrop = vi.fn();
  const opener = { id: 'opener-id', title: 'Supervisor' } as ConversationRuntime;
  const worker = {
    id: 'worker-id',
    title: 'Compiler worker',
    opened_by: opener.id,
  } as ConversationRuntime;
  const wake = createWorkerChatWake({
    openConversations: () => (openerOpen ? [opener, worker] : [worker]),
    routeInternal,
    logDrop,
  });
  return { inbox, addTell, send, routeInternal, logDrop, opener, worker, wake };
}

afterEach(() => {
  for (const router of routers.splice(0)) router.dispose();
});

describe('worker chat turn-end wake', () => {
  it.each(['completed', 'failed'] as const)(
    'delivers a %s outcome as one internal tell when the opener is busy',
    (kind) => {
      const h = makeWake(true);
      const outcome: ForgeRequestOutcome =
        kind === 'completed'
          ? { kind, finalText: 'done' }
          : { kind, error: 'provider failed', finalText: '' };

      h.wake(h.worker.id, outcome);

      expect(h.addTell).toHaveBeenCalledOnce();
      expect(h.addTell).toHaveBeenCalledWith(
        h.opener.id,
        expect.stringContaining('Compiler worker'),
        true,
        undefined,
        undefined,
        { kind: 'worker-wake', workerId: h.worker.id },
      );
      const [tell] = h.inbox.takeUndelivered(h.opener.id);
      expect(tell?.text).toContain(h.worker.id);
      expect(tell?.text).toContain(kind);
      expect(tell?.text).toContain('message_chat view');
      expect(tell?.text.length).toBeLessThanOrEqual(300);
    },
  );

  it('starts one internal turn when the opener is idle', () => {
    const h = makeWake(false);

    h.wake(h.worker.id, { kind: 'completed', finalText: 'done' });

    expect(h.send).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledWith(
      expect.stringContaining('Compiler worker'),
      undefined,
      h.opener.id,
      false,
      true,
    );
    expect(h.addTell).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'interrupted'] as const)('does not wake for %s', (kind) => {
    const h = makeWake(true);
    const outcome: ForgeRequestOutcome = { kind };

    h.wake(h.worker.id, outcome);

    expect(h.routeInternal).not.toHaveBeenCalled();
    expect(h.logDrop).not.toHaveBeenCalled();
  });

  it('logs once and drops the wake when its opener is closed', () => {
    const h = makeWake(false, false);

    h.wake(h.worker.id, { kind: 'completed', finalText: 'done' });

    expect(h.routeInternal).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.logDrop).toHaveBeenCalledOnce();
    expect(h.logDrop).toHaveBeenCalledWith(expect.stringContaining('opener opener-id'));
  });

  it('coalesces repeated busy wakes from one worker to the latest text', () => {
    const h = makeWake(true);

    h.wake(h.worker.id, { kind: 'completed', finalText: 'first' });
    h.wake(h.worker.id, { kind: 'failed', error: 'second', finalText: '' });

    const tells = h.inbox.takeUndelivered(h.opener.id);
    expect(tells).toHaveLength(1);
    expect(tells[0]?.text).toContain('failed');
    expect(tells[0]?.origin).toEqual({ kind: 'worker-wake', workerId: h.worker.id });
  });
});
