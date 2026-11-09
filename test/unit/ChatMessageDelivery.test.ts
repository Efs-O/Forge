import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSidebarPromptRouter,
  type SidebarPromptRouter,
} from '../../src/sidebar/backgroundExitNotice';
import type { ForgeRequestOutcome } from '../../src/sidebar/turnOutcome';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';

type Send = Parameters<typeof createSidebarPromptRouter>[0]['send'];

let router: SidebarPromptRouter | undefined;

function makeRouter(reserved: boolean, send: Send) {
  const addTell = vi.fn();
  router = createSidebarPromptRouter({
    activeId: () => 'active',
    isReserved: () => reserved,
    addTell,
    removeTell: () => false,
    markSendNow: () => false,
    isStreaming: () => false,
    interruptForSteering: () => Promise.resolve(),
    send,
    isOpen: () => true,
  });
  return { router, addTell };
}

afterEach(() => {
  router?.dispose();
  router = undefined;
});

describe('SidebarPromptRouter.deliverChatMessage', () => {
  const senderMark = {
    jobId: 'nightly-job',
    jobName: 'Nightly review',
  };

  it('adds a visible tell to a busy chat without sending', async () => {
    const send = vi.fn<Send>();
    const { router, addTell } = makeRouter(true, send);
    await expect(router.deliverChatMessage('hello', 'target')).resolves.toEqual({ kind: 'tell' });
    expect(addTell).toHaveBeenCalledWith('target', 'hello', false, undefined, undefined, {
      kind: 'chat',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('starts an echoed, non-internal turn and resolves after startup and prompt commit', async () => {
    // The turn never ends in this test: delivery must not wait for it.
    const send = vi.fn<Send>((...args) => {
      args[6]?.();
      return new Promise<ForgeRequestOutcome>(() => {});
    });
    const { router } = makeRouter(false, send);
    await expect(router.deliverChatMessage('hello', 'target')).resolves.toEqual({ kind: 'turn' });
    expect(send).toHaveBeenCalledWith(
      'hello',
      undefined,
      'target',
      true,
      false,
      undefined,
      expect.any(Function),
      { kind: 'chat' },
    );
  });

  it('reports a send refused before startup with its error', async () => {
    const send = vi.fn<Send>(() =>
      Promise.resolve<ForgeRequestOutcome>({ kind: 'failed', error: 'Forge: no active model.' }),
    );
    const { router } = makeRouter(false, send);
    await expect(router.deliverChatMessage('hello', 'target')).resolves.toEqual({
      kind: 'refused',
      error: 'Forge: no active model.',
    });
  });

  it('keeps `turn` when an admitted turn later fails', async () => {
    const send = vi.fn<Send>((...args) => {
      args[6]?.();
      return Promise.resolve<ForgeRequestOutcome>({ kind: 'failed', error: 'backend died' });
    });
    const { router } = makeRouter(false, send);
    await expect(router.deliverChatMessage('hello', 'target')).resolves.toEqual({ kind: 'turn' });
  });

  it('reports a rejected send as refused', async () => {
    const send = vi.fn<Send>(() => Promise.reject(new Error('boom')));
    const { router } = makeRouter(false, send);
    await expect(router.deliverChatMessage('hello', 'target')).resolves.toEqual({
      kind: 'refused',
      error: 'boom',
    });
  });

  it('inherits the sender job mark through an idle send until its turn settles', async () => {
    let settle!: (outcome: ForgeRequestOutcome) => void;
    const send = vi.fn<Send>((...args) => {
      args[6]?.();
      return new Promise<ForgeRequestOutcome>((resolve) => {
        settle = resolve;
      });
    });
    const sender = unattendedConversations.mark('sender', senderMark);
    const { router } = makeRouter(false, send);
    try {
      const delivery = router.deliverChatMessage('hello', 'target', false, { job: senderMark });
      await expect(delivery).resolves.toEqual({ kind: 'turn' });
      expect(unattendedConversations.has('target')).toBe(true);
      expect(unattendedConversations.jobMeta('target')).toEqual(senderMark);
      settle({ kind: 'completed' });
      await vi.waitFor(() => expect(unattendedConversations.has('target')).toBe(false));
      expect(unattendedConversations.jobMeta('target')).toBeUndefined();
    } finally {
      sender.dispose();
    }
  });

  it('keeps the sender job mark on an idle chat opened by new until its turn settles', async () => {
    let settle!: (outcome: ForgeRequestOutcome) => void;
    const send = vi.fn<Send>((...args) => {
      args[6]?.();
      return new Promise<ForgeRequestOutcome>((resolve) => {
        settle = resolve;
      });
    });
    const sender = unattendedConversations.mark('sender', senderMark);
    const { router } = makeRouter(false, send);
    try {
      const delivery = router.deliverChatMessage('first message', 'new-chat', false, {
        job: senderMark,
      });
      await expect(delivery).resolves.toEqual({ kind: 'turn' });
      expect(unattendedConversations.has('new-chat')).toBe(true);
      expect(unattendedConversations.jobMeta('new-chat')).toEqual(senderMark);
      settle({ kind: 'completed' });
      await vi.waitFor(() => expect(unattendedConversations.has('new-chat')).toBe(false));
      expect(unattendedConversations.jobMeta('new-chat')).toBeUndefined();
    } finally {
      sender.dispose();
    }
  });

  it('does not mark an idle recipient for an attended sender', async () => {
    const send = vi.fn<Send>((...args) => {
      args[6]?.();
      return Promise.resolve<ForgeRequestOutcome>({ kind: 'completed' });
    });
    const { router } = makeRouter(false, send);
    await expect(router.deliverChatMessage('hello', 'target')).resolves.toEqual({ kind: 'turn' });
    await Promise.resolve();
    expect(unattendedConversations.has('target')).toBe(false);
    expect(unattendedConversations.jobMeta('target')).toBeUndefined();
  });

  it('does not mark a busy recipient when an unattended sender adds a tell', async () => {
    const sender = unattendedConversations.mark('sender', senderMark);
    const { router } = makeRouter(true, vi.fn<Send>());
    try {
      await expect(
        router.deliverChatMessage('hello', 'target', false, { job: senderMark }),
      ).resolves.toEqual({ kind: 'tell' });
      expect(unattendedConversations.has('target')).toBe(false);
      expect(unattendedConversations.jobMeta('target')).toBeUndefined();
    } finally {
      sender.dispose();
    }
  });

  it('does not mark a busy recipient or overwrite an existing recipient mark', async () => {
    const sender = unattendedConversations.mark('sender', senderMark);
    const { router, addTell } = makeRouter(true, vi.fn<Send>());
    const ownMeta = { jobId: 'recipient-job', jobName: 'Recipient job' };
    const recipient = unattendedConversations.mark('target', ownMeta);
    try {
      await expect(
        router.deliverChatMessage('hello', 'target', false, { job: senderMark }),
      ).resolves.toEqual({ kind: 'tell' });
      expect(addTell).toHaveBeenCalledOnce();
      expect(unattendedConversations.jobMeta('target')).toEqual(ownMeta);
      expect(unattendedConversations.has('target')).toBe(true);
    } finally {
      recipient.dispose();
      sender.dispose();
    }
  });

  it('keeps an already-marked idle recipient under its own mark after delivery settles', async () => {
    let settle!: (outcome: ForgeRequestOutcome) => void;
    const send = vi.fn<Send>((...args) => {
      args[6]?.();
      return new Promise<ForgeRequestOutcome>((resolve) => {
        settle = resolve;
      });
    });
    const sender = unattendedConversations.mark('sender', senderMark);
    const ownMeta = { jobId: 'recipient-job', jobName: 'Recipient job' };
    const recipient = unattendedConversations.mark('target', ownMeta);
    const { router } = makeRouter(false, send);
    try {
      const delivery = router.deliverChatMessage('hello', 'target', false, { job: senderMark });
      await expect(delivery).resolves.toEqual({ kind: 'turn' });
      settle({ kind: 'completed' });
      await Promise.resolve();
      expect(unattendedConversations.has('target')).toBe(true);
      expect(unattendedConversations.jobMeta('target')).toEqual(ownMeta);
    } finally {
      recipient.dispose();
      sender.dispose();
    }
  });

  it('does not leave a mark when send returns nothing', async () => {
    const sender = unattendedConversations.mark('sender', senderMark);
    const { router } = makeRouter(false, vi.fn<Send>(() => undefined));
    try {
      await expect(
        router.deliverChatMessage('hello', 'target', false, { job: senderMark }),
      ).resolves.toEqual({ kind: 'refused', error: 'Forge: the chat could not start a turn.' });
      expect(unattendedConversations.has('target')).toBe(false);
      expect(unattendedConversations.jobMeta('target')).toBeUndefined();
    } finally {
      sender.dispose();
    }
  });
});
