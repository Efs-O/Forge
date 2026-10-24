import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSidebarPromptRouter,
  type SidebarPromptRouter,
} from '../../src/sidebar/backgroundExitNotice';
import type { ForgeRequestOutcome } from '../../src/sidebar/turnOutcome';

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
  it('adds a visible tell to a busy chat without sending', async () => {
    const send = vi.fn<Send>();
    const { router, addTell } = makeRouter(true, send);
    await expect(router.deliverChatMessage('hello', 'target')).resolves.toEqual({ kind: 'tell' });
    expect(addTell).toHaveBeenCalledWith('target', 'hello', false);
    expect(send).not.toHaveBeenCalled();
  });

  it('starts an echoed, non-internal turn in an idle chat and resolves on admission', async () => {
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
    );
  });

  it('reports a send refused before admission with its error', async () => {
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
});
