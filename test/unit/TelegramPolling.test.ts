import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramAlbumCoordinator } from '../../src/remote/TelegramAlbumBuffer';
import { pollTelegramUpdates } from '../../src/remote/TelegramPolling';
import { getLogger } from '../../src/util/logger';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Telegram polling update log', () => {
  it('logs one sanitized line per update and reports a slow acknowledgement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);
    const abort = new AbortController();
    const updates = [
      { update_id: 1, message: { message_id: 1, date: 1_700_000_000, chat: { id: 99, type: 'private' }, from: { id: 7 }, text: '/status@forge_bot secret message' } },
      { update_id: 2, callback_query: { id: 'callback-secret', data: 'x:private-id', from: { id: 7 }, message: { message_id: 2, chat: { id: 99, type: 'private' } } } },
      { update_id: 3, callback_query: { id: 'callback-secret-2', data: 'h:x', from: { id: 7 }, message: { message_id: 3, chat: { id: 99, type: 'private' } } } },
    ];
    const handled: string[] = [];
    let cursorWrites = 0;
    const albums = new TelegramAlbumCoordinator({
      handle: async () => ({ kind: 'handled' }),
      acknowledge: async () => undefined,
      commitCursor: async () => undefined,
      onOverflow: async () => undefined,
    });
    await pollTelegramUpdates(abort.signal, {
      call: async (method) => method === 'getUpdates' ? updates : undefined,
      getCursor: () => undefined,
      setCursor: async () => {
        cursorWrites += 1;
        if (cursorWrites === updates.length) abort.abort();
      },
      getHandler: () => async (event) => {
        if (event.kind === 'text') handled.push(event.text);
        return { kind: 'handled' };
      },
      acknowledge: async () => {
        const delay = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
        await vi.advanceTimersByTimeAsync(3_000);
        await delay;
      },
      albumCoordinator: albums,
    });
    expect(handled).toEqual(['/status secret message']);
    expect(info).toHaveBeenCalledTimes(4);
    expect(info.mock.calls[0]?.[0]).toContain('acknowledgement for update 1 took 3000 ms');
    expect(info.mock.calls[1]?.[0]).toContain('update 1 cmd /status lag=0 -> handled');
    expect(info.mock.calls[2]?.[0]).toContain('update 2 callback x lag=n/a -> handled');
    expect(info.mock.calls[3]?.[0]).toContain('update 3 callback h lag=n/a -> handled');
    const logs = info.mock.calls.map(([line]) => line).join('\n');
    expect(logs).not.toContain('secret message');
    expect(logs).not.toContain('private-id');
    expect(logs).not.toContain('callback-secret');
  });
});
