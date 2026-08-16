import { afterEach, describe, expect, it, vi } from 'vitest';
import { countChatCompletionInputTokens } from '../../src/llm/OpenAIClient';

const request = { model: 'm', messages: [], stream: true } as const;

afterEach(() => vi.unstubAllGlobals());

describe('countChatCompletionInputTokens', () => {
  it('returns llama-server\'s exact count for the complete chat request', async () => {
    const fetchMock = vi.fn(async () => Response.json({ input_tokens: 26510 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(countChatCompletionInputTokens('http://x', request)).resolves.toBe(26510);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://x/v1/chat/completions/input_tokens',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
    );
  });

  it('reports an unavailable token-count endpoint without treating it as a request failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(countChatCompletionInputTokens('http://x', request)).resolves.toBeUndefined();
  });
});
