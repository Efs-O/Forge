import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteOutboxDelivery } from '../../src/remote/RemoteOutboxDelivery';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { TelegramChannel } from '../../src/remote/TelegramChannel';
import { wireTurnMirror } from '../../src/sidebar/turnMirrorWiring';
import { createTurnSpeedLedger } from '../../src/sessions/turnSpeedTotals';
import type { HostActivityEvent } from '../../src/sidebar/HostActivity';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { RequestCapture } from '../../src/sessions/requestStats';

const LINE = 'Speed: 535 tokens at 21.1 tok/s · read 19,160 at 725.4 tok/s';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-speed-line-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
}

/** A Telegram transport with no network: every sendMessage body is captured. */
function telegramCapturing(bodies: Array<Record<string, unknown>>): TelegramChannel {
  return new TelegramChannel({
    token: 'secret-token',
    getCursor: () => undefined,
    setCursor: async () => undefined,
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      // The Bot API envelope, exactly as the real one answers: `{ok, result}`.
      // A fake that returned the bare message object hid the fact that nothing
      // downstream would have parsed it.
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: bodies.length } }),
      } as Response;
    }) as typeof fetch,
  });
}

const strataCapture = (): RequestCapture => ({
  body: '{"messages":[…]}',
  url: 'http://127.0.0.1:8092/v1/chat/completions',
  model: 'qwen3.8-flash-next-abliterated-iq2_xs',
  sentAtMs: 1_793_139_252_000,
  stats: {
    outcome: 'ok',
    finishReason: 'stop',
    client: { total_ms: 30_000, chunks: 192 },
    usage: { prompt_tokens: 19_389, completion_tokens: 535 },
    timings: {
      cache_n: 18_511,
      prompt_n: 19_160,
      prompt_ms: 26_412.1,
      predicted_n: 535,
      predicted_ms: 25_390.6,
      draft_n: 0,
      draft_n_accepted: 0,
    },
  },
});

describe('the speed line on a Telegram reply', () => {
  it('lands on the last part of a split answer and never gets cut in half', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const channel = telegramCapturing(bodies);
    await channel.send('chat-1', 'x'.repeat(4_100), { speedLine: LINE });

    expect(bodies).toHaveLength(2);
    const first = String(bodies[0]?.['text']);
    const last = String(bodies[1]?.['text']);
    expect(first).toHaveLength(4_096);
    expect(first).not.toContain('Speed:');
    expect(last).toContain(LINE);
    expect(last.split('Speed:').length - 1).toBe(1);
    expect(last.length).toBeLessThanOrEqual(4_096);
    // The answer survives the split intact and whole; only the line was added.
    const answerTail = last.replace(`\n\n${LINE}`, '');
    expect(`${first}${answerTail}`).toBe('x'.repeat(4_100));
  });

  it('puts the line on a short answer as one extra line of the same message', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const channel = telegramCapturing(bodies);
    await channel.send('chat-1', 'done, the fix is committed', { speedLine: LINE });
    expect(bodies).toHaveLength(1);
    expect(String(bodies[0]?.['text'])).toBe(`done, the fix is committed\n\n${LINE}`);
  });

  it('is display only: the stored item, the speech and the summary never carry it', async () => {
    const state = await store();
    const bodies: Array<Record<string, unknown>> = [];
    const spoken: string[] = [];
    const channel = telegramCapturing(bodies);
    await state.notifyOutbox('telegram', 'chat-1', 'the answer', { speedLine: LINE });
    const stored = state.pendingOutbox('telegram')[0]!;
    expect(stored.text).toBe('the answer');
    expect(stored.speedLine).toBe(LINE);

    const outbox = new RemoteOutboxDelivery(
      channel,
      state,
      12_000,
      new AbortController().signal,
      1_000,
      vi.fn(),
      async () => true,
      (_chatId, text) => {
        spoken.push(text);
        return Promise.resolve(false);
      },
      undefined,
      5,
    );
    outbox.start();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(String(bodies[0]?.['text'])).toBe(`the answer\n\n${LINE}`);
    // Speech reads `item.text`, so the phone never hears a speed line. It runs
    // after the delivered mark is written to disk, so wait for it.
    await vi.waitFor(() => expect(spoken).toEqual(['the answer']));
    await outbox.stop();
  });

  it('drops the lines when an unlock backlog is summarized', async () => {
    const state = await store();
    const bodies: Array<Record<string, unknown>> = [];
    for (let index = 1; index <= 13; index += 1)
      await state.notifyOutbox('telegram', 'chat-1', `message ${String(index)}`, {
        speedLine: LINE,
      });
    const outbox = new RemoteOutboxDelivery(
      telegramCapturing(bodies),
      state,
      2_000,
      new AbortController().signal,
      1_000,
      vi.fn(),
      async () => true,
      undefined,
      undefined,
      5,
    );
    outbox.start();
    // Delivery is one message at a time, so wait for the shape rather than for
    // any early sign of it: the summary plus the newest five in full.
    await vi.waitFor(() =>
      expect(bodies.filter((body) => String(body['text']).includes('Speed:'))).toHaveLength(5),
    );
    const summary = bodies.find((body) => String(body['text']).includes('held back'));
    expect(summary).toBeDefined();
    expect(String(summary?.['text'])).not.toContain('Speed:');
    expect(bodies).toHaveLength(6);
    // Only the newest five were delivered individually, each with its own line;
    // the eight summarized ones lost theirs along with their separate texts.
    await outbox.stop();
  });

  it('is carried beside the answer, never inside it, and never into the conversation', () => {
    const ledger = createTurnSpeedLedger();
    const messages = [
      { role: 'user', content: 'fix the parser' },
      { role: 'assistant', content: 'done, the fix is committed' },
    ];
    const conversation = { id: 'c1', messages } as unknown as ConversationRuntime;
    const before = JSON.stringify(messages);
    const events: {
      onGenerationStarted?: (model: string | null, id?: string) => void;
      onGenerationFinished?: (
        model: string | null,
        id: string | undefined,
        text: string | undefined,
        outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted',
      ) => void;
      onTurnFailed?: (id: string | undefined, message: string) => void;
    } = {};
    const emitted: HostActivityEvent[] = [];
    wireTurnMirror(events, {
      lookup: () => conversation,
      emit: (event) => emitted.push(event),
      endProgress: () => undefined,
      turnSpeeds: ledger,
    });

    events.onGenerationStarted?.('strata', 'c1');
    ledger.record('c1', strataCapture());
    events.onGenerationFinished?.('strata', 'c1', 'done, the fix is committed', 'completed');

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.text).toBe('done, the fix is committed');
    expect(emitted[0]?.text).not.toContain('Speed:');
    expect(emitted[0]?.speedLine).toBe(LINE);
    // The transcript and the model's next request come from these messages: they
    // are byte-identical, so the line never entered either.
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('leaves no line behind for a turn that failed midway', () => {
    const ledger = createTurnSpeedLedger();
    const events: {
      onGenerationStarted?: (model: string | null, id?: string) => void;
      onTurnFailed?: (id: string | undefined, message: string) => void;
    } = {};
    const emitted: HostActivityEvent[] = [];
    wireTurnMirror(events, {
      lookup: () => undefined,
      emit: (event) => emitted.push(event),
      endProgress: () => undefined,
      turnSpeeds: ledger,
    });

    events.onGenerationStarted?.('strata', 'c1');
    ledger.record('c1', strataCapture());
    events.onTurnFailed?.('c1', 'the backend stopped answering');

    expect(emitted[0]?.kind).toBe('failure');
    expect(emitted[0]?.speedLine).toBeUndefined();
    // Nothing is left: the next turn of this chat starts from zero.
    expect(ledger.takeLine('c1')).toBeUndefined();
    ledger.beginTurn('c1');
    expect(ledger.finishTurn('c1')).toBeUndefined();
  });
});
