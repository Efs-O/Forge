import { describe, expect, it, vi } from 'vitest';
import { CLI_MODEL_CHAT_ERROR, streamModelChatCompletion } from '../../src/llm/ChatClient';
import type { ModelConfig } from '../../src/config/types';

describe('streamModelChatCompletion provider: cli', () => {
  it('reports a clear structured error instead of dispatching an HTTP request', async () => {
    const onError = vi.fn();
    const model: ModelConfig = { name: 'claude-code', provider: 'cli', cli: 'claude' };
    await streamModelChatCompletion(
      'http://127.0.0.1:8080',
      { model: 'claude-code', messages: [], stream: true },
      model,
      {
        onToken: vi.fn(),
        onReasoning: vi.fn(),
        onToolCalls: vi.fn(),
        onDone: vi.fn(),
        onError,
      },
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as Error;
    expect(err.message).toBe(CLI_MODEL_CHAT_ERROR);
  });
});
