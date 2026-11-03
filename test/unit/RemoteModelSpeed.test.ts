import { describe, expect, it, vi } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { handleRemoteModelCommand } from '../../src/remote/remoteModelCommands';
import { createRemoteModelSpeedReader } from '../../src/remote/remoteModelSpeed';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import type { RemoteInboundEvent } from '../../src/remote/types';

/// Real Strata 0.1.50 `/v1/status` shape, captured on 2026-10-27 from
/// http://127.0.0.1:8092/v1/status. It has **no** top-level `at`: the
/// measurement time is `last_timings.at` in epoch seconds. The fixture used to
/// invent a top-level `at`, which is why `/speed` looked correct in tests while
/// answering "unavailable" for a running engine.
const measuredAtEpochSeconds = 1_793_139_252;
const timestamp = '2026-10-27T22:14:12.000Z';
const engineModel = 'qwen3.8-flash-next-abliterated-iq2_xs';

function config(endpoint = 'http://127.0.0.1:8092/v1', provider = 'openai-compatible') {
  return ForgeConfigSchema.parse({
    models: [{ name: 'strata', model: engineModel, group: 'local' }],
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

function status(model = engineModel, lastTimings: Record<string, unknown> = {}) {
  return {
    service: 'strata',
    model,
    loaded: true,
    auto_load: true,
    structured_output: {
      formats: ['json_object', 'json_schema'],
      method: 'prompt_and_validate',
      constrained_decoding: false,
      stream_buffered: true,
    },
    engine: '0.1.50',
    started: 1_793_131_636,
    uptime_s: 7_591,
    cache_max_tokens: 400_000,
    context: { native: 400_000, max_positions: 400_000 },
    concurrency: { serving: 2, requested: 2 },
    dialects: ['/v1/chat/completions', '/v1/messages', '/v1/responses'],
    vision: { enabled: true, available: true, error: null },
    image_generation: { enabled: false },
    activity: { requests: 263, in_flight: 1, last_request_at: measuredAtEpochSeconds },
    last_timings: {
      cache_n: 114_556,
      prompt_n: 517,
      prompt_ms: 3_668.7,
      prompt_per_token_ms: 7.096,
      prompt_per_second: 140.9,
      predicted_n: 370,
      predicted_ms: 8_989.4,
      predicted_per_token_ms: 24.296,
      predicted_per_second: 41.2,
      draft_n: 0,
      draft_n_accepted: 0,
      at: measuredAtEpochSeconds,
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
      model: engineModel,
      at: timestamp,
      predictedPerSecond: 41.2,
      promptPerSecond: 140.9,
      predictedN: 370,
      promptN: 517,
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
      // A time that describes nothing: the numbers it belonged to are gone.
      status('qwen3.8-flash-next-abliterated-iq2_xs', { at: 'not-a-timestamp' }),
      // The old contract's shape — a top-level `at` with no time inside the
      // timings. Kept as a refusal, not silently accepted: the timestamp must
      // arrive with the request it measures.
      { ...status(), at: timestamp, last_timings: { ...status().last_timings, at: undefined } },
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
        model: engineModel,
        at: timestamp,
        predictedPerSecond: 41.2,
        promptPerSecond: 140.9,
        predictedN: 370,
        promptN: 517,
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
      `Forge: latest completed model request (model-global) for ${engineModel}: 370 output tokens at 41.2 tok/s; 517 prompt tokens at 140.9 tok/s. Measured at ${timestamp}.`,
    );
  });
});
