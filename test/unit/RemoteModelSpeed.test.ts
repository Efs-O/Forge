import { describe, expect, it, vi } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { handleRemoteModelCommand } from '../../src/remote/remoteModelCommands';
import { createRemoteModelSpeedReader } from '../../src/remote/remoteModelSpeed';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import type { RemoteInboundEvent } from '../../src/remote/types';

const timestamp = '2026-10-25T12:00:00.000Z';

function config(endpoint = 'http://127.0.0.1:8092/v1', provider = 'openai-compatible') {
  return ForgeConfigSchema.parse({
    models: [{ name: 'strata', model: 'strata-engine', group: 'local' }],
    groups: { local: { provider, endpoint } },
    active_model: 'strata',
  });
}

function response(value: unknown): Response {
  return {
    ok: true,
    json: async () => value,
  } as Response;
}

function status(model = 'strata-engine', lastTimings: Record<string, unknown> = {}) {
  return {
    model,
    at: timestamp,
    last_timings: {
      predicted_per_second: 41.7,
      prompt_per_second: 820.2,
      predicted_n: 200,
      prompt_n: 1_250,
      ...lastTimings,
    },
  };
}

describe('remote model speed snapshot', () => {
  it('reads one configured local status endpoint and requires exact model identity', async () => {
    const fetchImpl = vi.fn(async () => response(status()));
    const readSpeed = createRemoteModelSpeedReader(config(), fetchImpl);
    const metrics = await readSpeed('strata', new AbortController().signal);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8092/v1/status');
    expect(metrics).toEqual({
      model: 'strata-engine',
      at: timestamp,
      predictedPerSecond: 41.7,
      promptPerSecond: 820.2,
      predictedN: 200,
      promptN: 1_250,
    });
    expect(
      await createRemoteModelSpeedReader(config(), async () => response(status('other-model')))(
        'strata',
        new AbortController().signal,
      ),
    ).toBeUndefined();
  });

  it('does not probe non-compatible or non-loopback providers', async () => {
    const fetchImpl = vi.fn(async () => response(status()));
    expect(
      await createRemoteModelSpeedReader(config('http://127.0.0.1:11434', 'ollama'), fetchImpl)(
        'strata',
        new AbortController().signal,
      ),
    ).toBeUndefined();
    expect(
      await createRemoteModelSpeedReader(config('https://example.test/v1'), fetchImpl)(
        'strata',
        new AbortController().signal,
      ),
    ).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { predicted_per_second: Number.NaN },
    { prompt_per_second: Number.POSITIVE_INFINITY },
    { predicted_n: -1 },
    { prompt_n: 2.5 },
  ])('rejects invalid timing values %#', async (timings) => {
    const readSpeed = createRemoteModelSpeedReader(config(), async () =>
      response(status('strata-engine', timings)),
    );
    await expect(readSpeed('strata', new AbortController().signal)).resolves.toBeUndefined();
  });

  it('returns unavailable for missing completion data and an invalid measurement time', async () => {
    for (const sample of [
      { ...status(), last_timings: undefined },
      { ...status(), at: 'not-a-timestamp' },
    ]) {
      const readSpeed = createRemoteModelSpeedReader(config(), async () => response(sample));
      await expect(readSpeed('strata', new AbortController().signal)).resolves.toBeUndefined();
    }
  });

  it('forwards cancellation and returns unavailable without a speed', async () => {
    const parent = new AbortController();
    parent.abort();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
      expect(init.signal?.aborted).toBe(true);
      throw new DOMException('cancelled', 'AbortError');
    });
    const readSpeed = createRemoteModelSpeedReader(config(), fetchImpl);
    await expect(readSpeed('strata', parent.signal)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('sends a one-time /speed reply labeled as the latest completed model request', async () => {
    const channel = new FakeRemoteChannel('telegram');
    const context = {
      channel,
      store: { binding: () => ({ conversationId: 'conversation-1' }) },
      host: {
        status: () => ({ conversations: [{ id: 'conversation-1', activeModel: 'strata' }] }),
      },
      signal: new AbortController().signal,
      getLatestModelSpeed: vi.fn(async () => ({
        model: 'strata-engine',
        at: timestamp,
        predictedPerSecond: 41.7,
        promptPerSecond: 820.2,
        predictedN: 200,
        promptN: 1_250,
      })),
    } as unknown as RemoteCommandContext;
    const event: Extract<RemoteInboundEvent, { kind: 'text' }> = {
      channel: 'telegram',
      kind: 'text',
      providerMessageId: 'message-1',
      senderId: 'owner',
      chatId: 'chat-1',
      chatType: 'private',
      receivedAt: 1,
      text: '/speed',
    };

    await expect(handleRemoteModelCommand('/speed', undefined, event, context)).resolves.toEqual({
      kind: 'handled',
    });
    expect(context.getLatestModelSpeed).toHaveBeenCalledWith('strata', context.signal);
    expect(channel.sent[0]?.text).toBe(
      'Forge: latest completed model request (model-global) for strata-engine: 200 output tokens at 41.7 tok/s; 1250 prompt tokens at 820.2 tok/s. Measured at 2026-10-25T12:00:00.000Z.',
    );
  });
});
