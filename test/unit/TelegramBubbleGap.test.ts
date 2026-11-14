import { describe, expect, it } from 'vitest';
import { TelegramChannel } from '../../src/remote/TelegramChannel';
import { withTelegramBubbleGap } from '../../src/remote/telegramBubbleGap';

/** One untrimmable blank line, the shape `telegramBubbleGap` documents. */
const GAP = '\u2800\n';

function telegramCapturing(bodies: Array<Record<string, unknown>>): TelegramChannel {
  return new TelegramChannel({
    token: 'secret-token',
    getCursor: () => undefined,
    setCursor: async () => undefined,
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: bodies.length } }),
      } as Response;
    }) as typeof fetch,
  });
}

describe('the gap between Telegram bubbles', () => {
  it('puts one blank line above the body, and only one', () => {
    expect(withTelegramBubbleGap('working')).toBe(`${GAP}working`);
    // Idempotent: a live bubble is edited on every update, and a gap that grew
    // with each edit would fill the phone with empty lines.
    expect(withTelegramBubbleGap(withTelegramBubbleGap('working'))).toBe(`${GAP}working`);
    // A blank line the body arrived with is replaced, never stacked.
    expect(withTelegramBubbleGap('\n\nworking')).toBe(`${GAP}working`);
    // Real first-line content is untouched.
    expect(withTelegramBubbleGap('  indented code')).toBe(`${GAP}  indented code`);
  });

  it('opens every kind of bubble with it: reply, notice, card, status and edit', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const channel = telegramCapturing(bodies);

    await channel.send('chat', 'the answer');
    await channel.sendHtml('chat', '<b>bold</b>');
    await channel.sendInlineKeyboard('chat', 'Choose one', [[{ text: 'A', callbackData: 'q:1' }]]);
    await channel.sendProgress('chat', 'Forge: working…', { stopButton: true });
    await channel.editMessage('chat', '4', 'Forge: completed.');

    expect(bodies).toHaveLength(5);
    for (const body of bodies) expect(String(body['text']).startsWith(GAP)).toBe(true);
  });

  it('keeps exactly one gap when a status bubble is edited again and again', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const channel = telegramCapturing(bodies);

    await channel.sendProgress('chat', 'Forge: working…', { stopButton: true });
    for (let index = 0; index < 5; index += 1) {
      await channel.editMessage('chat', '4', 'Forge: reading files…', { stopButton: true });
    }

    expect(bodies).toHaveLength(6);
    for (const body of bodies) {
      const text = String(body['text']);
      expect(text.startsWith(`${GAP}Forge:`)).toBe(true);
      // Never two gap lines in a row, however often this bubble was edited.
      expect(/^(?:\u2800\n){2,}/u.test(text)).toBe(false);
    }
  });

  it('rides the first part only, and never pushes a part over the limit', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const channel = telegramCapturing(bodies);
    // A body one character past what fits beside the gap: the split holds the
    // gap's two characters back, so no part arrives over 4096 and no part is
    // the gap alone.
    await channel.send('chat', 'x'.repeat(4_095));

    const parts = bodies.map((body) => String(body['text']));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect([...part].length).toBeLessThanOrEqual(4_096);
    expect(parts[0]!.startsWith(GAP)).toBe(true);
    expect(parts.slice(1).every((part) => !part.startsWith(GAP))).toBe(true);
    expect(parts.join('').replace(GAP, '')).toBe('x'.repeat(4_095));
  });

  it('fits a short bubble whole, gap included', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const channel = telegramCapturing(bodies);
    await channel.send('chat', 'x'.repeat(4_094));
    expect(bodies).toHaveLength(1);
    expect(String(bodies[0]?.['text'])).toBe(`${GAP}${'x'.repeat(4_094)}`);
  });
});
