import { describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../src/config/types';
import { startStrataBusyWarning } from '../../src/sidebar/strataBusyWarning';
import type { HostToWebview } from '../../src/sidebar/messageBridge';

const strataModel: ModelConfig = {
  name: 'strata',
  provider: 'openai-compatible',
  endpoint: 'http://127.0.0.1:8092',
  model: 'iq2_xs',
  unload_path: '/unload',
};

function status(inFlight: number, capacity = 2, model = 'iq2_xs'): Response {
  return new Response(JSON.stringify({
    service: 'strata',
    model,
    loaded: true,
    concurrency: { serving: capacity },
    activity: { in_flight: inFlight },
  }), { status: 200 });
}

function settleWarning(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function run(
  fetchImpl: typeof fetch,
  streamingIds: ReadonlySet<string> = new Set(),
  model: ModelConfig = strataModel,
): { fetch: ReturnType<typeof vi.fn<typeof fetch>>; post: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn<typeof globalThis.fetch>(fetchImpl);
  const post = vi.fn<(message: HostToWebview) => void>();
  startStrataBusyWarning(model, 'current', streamingIds, post, undefined, fetch);
  return { fetch, post };
}

describe('Strata busy turn warning', () => {
  it('posts one warning with the current in-flight and serving-limit numbers', async () => {
    const { post } = run(vi.fn(async () => status(2)));
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith({
      type: 'notice',
      severity: 'warning',
      conversationId: 'current',
      message:
        'Strata is already serving 2 chat(s), its limit at full speed is 2. This chat will share the engine, and every running chat will slow down.',
    });
  });

  it('does not warn below capacity when no other conversation is streaming', async () => {
    const { fetch, post } = run(vi.fn(async () => status(1)));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await settleWarning();
    expect(post).not.toHaveBeenCalled();
  });

  it('counts other conversations streaming in this window when status is lower', async () => {
    const { post } = run(vi.fn(async () => status(0)), new Set(['current', 'other-a', 'other-b']));
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0]![0]).toMatchObject({
      type: 'notice',
      message: expect.stringContaining('serving 2 chat(s)'),
    });
  });

  it('does not fetch for a model without the managed Strata unload path', async () => {
    const nonStrata = { ...strataModel, unload_path: undefined };
    const { fetch, post } = run(vi.fn(async () => status(2)), new Set(), nonStrata);
    expect(fetch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('does not fetch status from a remote managed endpoint', async () => {
    const remoteModel = { ...strataModel, endpoint: 'https://models.example.test' };
    const { fetch, post } = run(vi.fn(async () => status(2)), new Set(), remoteModel);
    expect(fetch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ['rejects', vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))],
    ['times out', vi.fn<typeof fetch>().mockRejectedValue(new DOMException('timeout', 'TimeoutError'))],
    ['reports a different model', vi.fn(async () => status(2, 2, 'other-model'))],
    ['returns an invalid schema', vi.fn(async () => new Response('{}', { status: 200 }))],
  ])('continues without a notice when the status read %s', async (_case, fetchImpl) => {
    const { fetch, post } = run(fetchImpl as typeof fetch);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await settleWarning();
    expect(post).not.toHaveBeenCalled();
  });

  it('starts the check once for the turn, outside the model-request loop', async () => {
    const { fetch, post } = run(vi.fn(async () => status(2)));
    // runModelTurn calls this helper once before entering the loop, regardless
    // of how many tool rounds (and model requests) that loop performs.
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledOnce();
  });
});
