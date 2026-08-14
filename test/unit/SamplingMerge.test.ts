import { describe, expect, it } from 'vitest';
import { mergeSampling } from '../../src/llm/SamplingMerge';
import type { ModelConfig } from '../../src/config/types';
import type { ChatCompletionRequest } from '../../src/llm/types';

const baseRequest: ChatCompletionRequest = {
  model: 'local',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
};

describe('mergeSampling', () => {
  it('uses the documented coding baseline instead of the stale low-temperature default', () => {
    expect(mergeSampling(baseRequest)).toMatchObject({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0.05,
      max_tokens: 4096,
    });
  });

  it('keeps explicit Qwen sampling configuration over global defaults', () => {
    const qwen: ModelConfig = {
      name: 'qwen38',
      gguf_path: 'C:/models/qwen38.gguf',
      sampling: {
        temperature: 0.6,
        top_p: 0.95,
        top_k: 20,
        min_p: 0,
        presence_penalty: 0,
        repetition_penalty: 1,
        max_tokens: 32768,
      },
    };

    expect(mergeSampling(baseRequest, qwen)).toMatchObject(qwen.sampling!);
  });
});
