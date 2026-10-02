import { describe, expect, it } from 'vitest';
import { normalizeRequestForModel } from '../../src/llm/RequestNormalizer';
import type { ModelConfig } from '../../src/config/types';
import { ReasoningEffortSchema } from '../../src/config/schemaShared';
import type { ChatCompletionRequest } from '../../src/llm/types';
import { buildRoundRequest } from '../../src/agent/buildRoundRequest';

const baseRequest: ChatCompletionRequest = {
  model: 'demo',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
  temperature: 0.6,
  top_p: 0.95,
  top_k: 40,
  min_p: 0.05,
  max_tokens: 1000,
  seed: 0,
  repeat_last_n: 64,
  stop: '<end_of_turn>',
  chat_template_kwargs: { enable_thinking: true },
  tools: [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object' },
      },
    },
  ],
};

describe('normalizeRequestForModel', () => {
  it('preserves recovery thinking suppression for native Ollama', () => {
    const model: ModelConfig = { name: 'qwen', provider: 'ollama', think: true };
    const request = buildRoundRequest({
      model,
      prepared: baseRequest.messages,
      toolDefinitions: [],
      nativeTools: false,
      stripAllTools: false,
      includeUsage: false,
      maxOutputTokens: undefined,
      canUseThinkingKwargs: false,
      suppressThinking: true,
      outputRoom: undefined,
    }).request as ChatCompletionRequest & { think?: boolean };

    expect(request.think).toBe(false);
  });

  it('preserves Ollama-native sampling fields and maps thinking controls', () => {
    const model: ModelConfig = {
      name: 'gemma4:26b',
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      think: false,
    };

    const normalized = normalizeRequestForModel(baseRequest, model);
    expect(normalized.top_k).toBe(40);
    expect(normalized.min_p).toBe(0.05);
    expect(normalized.chat_template_kwargs).toBeUndefined();
    expect(normalized.reasoning_effort).toBe('none');
    expect(normalized.repeat_last_n).toBe(64);
    expect(normalized.seed).toBe(0);
    expect(normalized.stop).toBe('<end_of_turn>');
    expect(normalized.tools).toHaveLength(1);
  });

  it('enables prompt-prefix caching for llama.cpp requests', () => {
    const model: ModelConfig = {
      name: 'local-gguf',
      provider: 'llama.cpp',
      gguf_path: 'C:/models/local.gguf',
      think: true,
    };

    expect(normalizeRequestForModel(baseRequest, model)).toEqual({
      ...baseRequest,
      cache_prompt: true,
    });
  });

  it('preserves an explicit llama.cpp cache_prompt override', () => {
    const model: ModelConfig = {
      name: 'local-gguf',
      provider: 'llama.cpp',
      gguf_path: 'C:/models/local.gguf',
    };

    expect(normalizeRequestForModel({ ...baseRequest, cache_prompt: false }, model).cache_prompt).toBe(
      false,
    );
  });

  it('passes a direct llama.cpp reasoning effort into template kwargs', () => {
    const model: ModelConfig = {
      name: 'qwen38',
      provider: 'llama.cpp',
      gguf_path: 'C:/models/qwen38.gguf',
      think: true,
      reasoning_effort: 'medium',
    };

    expect(normalizeRequestForModel(baseRequest, model).chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_effort: 'medium',
    });
  });

  it('accepts xhigh in config and forwards it to the llama.cpp template', () => {
    expect(ReasoningEffortSchema.parse('xhigh')).toBe('xhigh');
    const model: ModelConfig = {
      name: 'qwopus',
      provider: 'llama.cpp',
      gguf_path: 'C:/models/qwopus.gguf',
      think: true,
      reasoning_effort: 'xhigh',
    };

    expect(normalizeRequestForModel(baseRequest, model).chat_template_kwargs).toMatchObject({
      reasoning_effort: 'xhigh',
    });
  });

  it('maps the resolved thinking control to a template enable_thinking kwarg', () => {
    const model: ModelConfig = {
      name: 'nemotron',
      provider: 'llama.cpp',
      gguf_path: 'C:/models/nemotron.gguf',
      chat_template_thinking: true,
      think: false,
    };

    const { chat_template_kwargs: _omitted, ...withoutKwargs } = baseRequest;
    expect(normalizeRequestForModel(withoutKwargs, model).chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
  });

  it('keeps an explicit enable_thinking:false from a recovery round', () => {
    const model: ModelConfig = {
      name: 'nemotron',
      provider: 'llama.cpp',
      gguf_path: 'C:/models/nemotron.gguf',
      chat_template_thinking: true,
      think: true,
    };
    const request = { ...baseRequest, chat_template_kwargs: { enable_thinking: false } };

    expect(normalizeRequestForModel(request, model).chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
  });

  it('forwards a configured reasoning effort to an openai-compatible server', () => {
    const model: ModelConfig = {
      name: 'strata',
      provider: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8080',
      reasoning_effort: 'medium',
    };

    expect(normalizeRequestForModel(baseRequest, model)).toEqual({
      ...baseRequest,
      reasoning_effort: 'medium',
    });
  });

  it('sends no reasoning effort to an openai-compatible server unless configured', () => {
    const model: ModelConfig = { name: 'cloud', provider: 'openai-compatible' };

    expect(normalizeRequestForModel(baseRequest, model)).toBe(baseRequest);
  });

  it('keeps a request-level effort and drops the config one when thinking is off', () => {
    const model: ModelConfig = {
      name: 'cloud',
      provider: 'openrouter',
      reasoning_effort: 'xhigh',
    };
    const request = { ...baseRequest, reasoning_effort: 'low' as const };

    expect(normalizeRequestForModel(request, model).reasoning_effort).toBe('low');
    expect(
      normalizeRequestForModel(baseRequest, { ...model, think: false }).reasoning_effort,
    ).toBeUndefined();
  });
});
