import { describe, expect, it } from 'vitest';
import { TelegramChannel } from '../../src/remote/TelegramChannel';
import type { TelegramCallbackQuery } from '../../src/remote/TelegramInboundMapping';
import { mapTelegramCallbackQuery } from '../../src/remote/telegramCallbackMapping';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Always in this project Telegram approval button', () => {
  it('shows only on offered cards and maps its callback to the owner decision', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const channel = new TelegramChannel({
      token: 'test-token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({ ok: true, result: { message_id: bodies.length } });
      }) as typeof fetch,
    });
    const correlationId = 'x'.repeat(24);
    await channel.send('chat', 'approval without project offer', { correlationId });
    await channel.send('chat', 'approval with project offer', {
      correlationId,
      approvalAlwaysInProject: true,
    });

    const rows = (index: number) =>
      (
        bodies[index]?.['reply_markup'] as {
          inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
        }
      ).inline_keyboard;
    const labels = (index: number): string[][] =>
      rows(index).map((row) => row.map((button) => button.text));
    expect(labels(0)).toEqual([['Decline', 'Approve']]);
    // The project rule goes below the two answers that run or refuse THIS call,
    // not beside them: four buttons across one row is what Telegram truncates on
    // a phone, and this is the longest label of the four.
    expect(labels(1)).toEqual([
      ['Decline', 'Approve'],
      ['Always in this project'],
    ]);
    expect(rows(1)[1]![0]?.callback_data).toBe(`p:${correlationId}`);

    const callback: TelegramCallbackQuery = {
      id: 'callback-1',
      data: `p:${correlationId}`,
      from: { id: 1 },
      message: { message_id: 2, chat: { id: 3, type: 'private' } },
    };
    expect(mapTelegramCallbackQuery(callback, () => 'private')).toMatchObject({
      kind: 'action',
      action: 'always_project',
      correlationId,
    });
  });
});
