import { describe, expect, it } from 'vitest';
import type { ForgeConfig, LlamaServerConfig, ModelConfig } from '../../src/config/types';
import { mergeGroupsIntoModel } from '../../src/config/ConfigResolver';
import { composeLlamaServerArgs } from '../../src/backend/LlamaServerArgs';
import type { ChatCompletionRequest, ChatMessage, ToolDefinition } from '../../src/llm/types';
import {
  CHARS_PER_TOKEN,
  DEFAULT_LLAMA_CTX,
  DEFAULT_LLAMA_PARALLEL,
  IMAGE_PART_TOKENS,
  computeContextBudget,
  createOutputBudgetTracker,
  estimateTokens,
  estimateToolTokens,
  perSlotContext,
  type PromptAnchor,
  promptEstimateScale,
  reasoningReserve,
  reportedContextTokens,
  snapshotPromptRequest,
  SYSTEM_AND_TEMPLATE_OVERHEAD,
} from '../../src/util/contextBudget';

describe('perSlotContext', () => {
  // --ctx-size is the TOTAL and --parallel divides it (LlamaServerArgs). Reading
  // num_ctx alone reported every multi-slot model at several times its window.
  it('divides the configured window by the slot count', () => {
    const model = {
      name: 'm',
      provider: 'llama.cpp',
      gguf_path: 'm.gguf',
      num_ctx: 131072,
      spawn: { n_parallel: 4 },
    } as ModelConfig;
    expect(perSlotContext(model, undefined, 'llama.cpp')).toBe(32768);
  });

  it('gives a single-slot model the whole window', () => {
    const model = {
      name: 'm',
      provider: 'llama.cpp',
      gguf_path: 'm.gguf',
      num_ctx: 49152,
      spawn: { n_parallel: 1 },
    } as ModelConfig;
    expect(perSlotContext(model, undefined, 'llama.cpp')).toBe(49152);
  });

  it('falls back to the server defaults when the model sets neither', () => {
    const model = { name: 'm', provider: 'llama.cpp', gguf_path: 'm.gguf' } as ModelConfig;
    expect(
      perSlotContext(model, { default_num_ctx: 65536, n_parallel: 2 }, 'llama.cpp'),
    ).toBe(32768);
  });

  it('gives every slot the whole window under --kv-unified, last flag winning', () => {
    const args = (extra: string[]) =>
      ({
        name: 'm',
        provider: 'llama.cpp',
        gguf_path: 'm.gguf',
        num_ctx: 131072,
        spawn: { n_parallel: 4, extra_llama_server_args: extra },
      }) as ModelConfig;
    expect(perSlotContext(args(['--kv-unified']), undefined, 'llama.cpp')).toBe(131072);
    expect(perSlotContext(args(['-kvu', '--checkpoint-min-step', '1024']), undefined, 'llama.cpp')).toBe(131072);
    expect(perSlotContext(args(['--kv-unified', '--no-kv-unified']), undefined, 'llama.cpp')).toBe(32768);
  });

  it('reports 0 for a model with no configured window', () => {
    expect(perSlotContext({ name: 'gpt', provider: 'openai' } as ModelConfig, undefined, 'openai')).toBe(0);
  });

  it('uses the launcher defaults for a llama.cpp entry without an explicit parallel count', () => {
    const model = {
      name: 'long-context',
      provider: 'llama.cpp',
      gguf_path: 'model.gguf',
      num_ctx: 131072,
    } as ModelConfig;
    expect(perSlotContext(model, undefined, 'llama.cpp')).toBe(32768);
    expect(
      perSlotContext(
        { ...model, spawn: { extra_llama_server_args: ['--kv-unified'] } },
        undefined,
        'llama.cpp',
      ),
    ).toBe(131072);
  });

  it('uses the launcher context default when a llama.cpp entry has no window configured', () => {
    const model = { name: 'm', provider: 'llama.cpp', gguf_path: 'm.gguf' } as ModelConfig;
    expect(perSlotContext(model, undefined, 'llama.cpp')).toBe(1024);
  });

  it('does not apply llama-server defaults to an Ollama provider inherited from its group', () => {
    const raw = { name: 'ollama-model', group: 'ollama', num_ctx: 131072 } as ModelConfig;
    const config = {
      models: [raw],
      groups: { ollama: { provider: 'ollama' } },
    } as ForgeConfig;
    const merged = mergeGroupsIntoModel(config, raw);
    const provider = merged.provider ?? 'llama.cpp';
    const server = { default_num_ctx: 4096, n_parallel: 4 } as LlamaServerConfig;
    expect(provider).toBe('ollama');
    expect(perSlotContext(raw, server, provider)).toBe(131072);
    expect(perSlotContext(merged, server, provider)).toBe(131072);
  });

  it('does not divide or use llama-server defaults for external providers', () => {
    const server = { default_num_ctx: 4096, n_parallel: 4 } as LlamaServerConfig;
    expect(
      perSlotContext(
        { name: 'compatible', provider: 'openai-compatible', num_ctx: 131072 } as ModelConfig,
        server,
        'openai-compatible',
      ),
    ).toBe(131072);
    expect(perSlotContext({ name: 'cloud', provider: 'openai' } as ModelConfig, server, 'openai')).toBe(0);
  });

  it('builds llama-server context and parallel defaults from the shared constants', () => {
    const args = composeLlamaServerArgs(
      'llama-server',
      { name: 'm', provider: 'llama.cpp', gguf_path: 'm.gguf' } as ModelConfig,
      {} as LlamaServerConfig,
      '127.0.0.1',
      8080,
    );
    expect(DEFAULT_LLAMA_CTX).toBe(4096);
    expect(DEFAULT_LLAMA_PARALLEL).toBe(4);
    expect(args[args.indexOf('--ctx-size') + 1]).toBe(String(DEFAULT_LLAMA_CTX));
    expect(args[args.indexOf('--parallel') + 1]).toBe(String(DEFAULT_LLAMA_PARALLEL));
  });
});

describe('reasoningReserve', () => {
  it('reads --reasoning-budget out of the spawn args', () => {
    const model = {
      name: 'm',
      spawn: {
        extra_llama_server_args: ['--reasoning-budget', '8192', '--spec-type', 'draft-mtp'],
      },
    } as ModelConfig;
    expect(reasoningReserve(model)).toBe(8192);
  });

  it('is zero when no budget is configured', () => {
    expect(reasoningReserve({ name: 'm' } as ModelConfig)).toBe(0);
  });

  it('ignores a malformed budget rather than poisoning the arithmetic', () => {
    const model = {
      name: 'm',
      spawn: { extra_llama_server_args: ['--reasoning-budget'] },
    } as ModelConfig;
    expect(reasoningReserve(model)).toBe(0);
  });
});

describe('estimateTokens', () => {
  it.each<{ content: ChatMessage['content'] }>([
    { content: 'Writing the file.' },
    { content: [{ type: 'text', text: 'Writing the file.' }] },
  ])('counts tool arguments alongside visible content: $content', ({ content }) => {
    const calls: NonNullable<ChatMessage['tool_calls']> = [
      {
        id: 'write',
        type: 'function',
        function: {
          name: 'write_file',
          arguments: JSON.stringify({ content: 'code'.repeat(3000) }),
        },
      },
    ];
    expect(estimateTokens([{ role: 'assistant', content, tool_calls: calls }])).toBe(
      Math.ceil(('Writing the file.'.length + JSON.stringify(calls).length) / CHARS_PER_TOKEN),
    );
  });

  it('charges the measured image ceiling per part, independent of URL length', () => {
    expect(IMAGE_PART_TOKENS).toBe(1100);
    expect(
      estimateTokens([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect both images.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,small' } },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${'x'.repeat(12000)}` } },
          ],
        },
      ]),
    ).toBe(Math.ceil('Inspect both images.'.length / CHARS_PER_TOKEN) + 2200);
  });

  // ChatMessage.reasoning is retained for the sidebar's thinking pane but is
  // never sent back to the model, so it costs no prompt tokens. Counting it
  // inflated the bar by the whole turn's thinking — ToolCallingLoop attaches
  // reasoning to EVERY tool-call round, so the error compounded per round.
  it('ignores reasoning, which is never sent to the model', () => {
    const withoutReasoning = [{ role: 'assistant' as const, content: 'hello' }];
    const withReasoning = [
      { role: 'assistant' as const, content: 'hello', reasoning: 'z'.repeat(20000) },
    ];
    expect(estimateTokens(withReasoning)).toBe(estimateTokens(withoutReasoning));
  });
});

describe('reported prompt anchors', () => {
  const model = { name: 'm', num_ctx: 200_000, spawn: { n_parallel: 1 } } as ModelConfig;
  const tools: ToolDefinition[] = [
    {
      type: 'function',
      function: { name: 'read_file', description: 'Read source.', parameters: { type: 'object' } },
    },
  ];
  const request = (): ChatCompletionRequest => ({
    model: model.name,
    stream: true,
    messages: [
      { role: 'system', content: 'Work carefully.' },
      { role: 'user', content: 'Review the source.' },
    ],
    tools: structuredClone(tools),
  });
  const anchorFor = (sent: ChatCompletionRequest): PromptAnchor => ({
    ...snapshotPromptRequest(sent),
    promptTokens: 150_000,
    completionTokens: 4000,
  });
  const generated: ChatMessage = { role: 'assistant', content: 'Checking the source.' };

  it('uses reported prompt and completion, estimating only the later tail and new delimiters', () => {
    const sent = request();
    const assistant: ChatMessage = {
      role: 'assistant',
      content: 'A'.repeat(60_000),
      tool_calls: [
        { id: 'read', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ],
    };
    const tail: ChatMessage = {
      role: 'tool',
      tool_call_id: 'read',
      content: [
        { type: 'text', text: 'x'.repeat(34_000) },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,image' } },
      ],
    };
    const budget = computeContextBudget({
      messages: [...sent.messages, assistant, tail],
      model,
      tools,
      toolTokens: estimateToolTokens(tools),
      anchor: anchorFor(sent),
      estimateScale: 1.2,
    });
    // The image is charged once at its fixed ceiling, never multiplied by scale.
    const estimatedNewPart = 12_000 + 1100 + 2 * 16;
    expect(budget.used).toBe(150_000 + 4000 + estimatedNewPart);
    expect(budget.extraMarginTokens).toBe(estimatedNewPart);
    expect(budget.outputRoom).toBe(200_000 - budget.used);
  });

  it('retains the full reported completion even when only the generated assistant was added', () => {
    const sent = request();
    const budget = computeContextBudget({
      messages: [...sent.messages, generated],
      model,
      tools,
      anchor: anchorFor(sent),
    });
    expect(budget.used).toBe(154_016);
    expect(budget.extraMarginTokens).toBe(16);
  });

  it('never scales the newly estimated tail below its original estimate', () => {
    const sent = request();
    const budget = computeContextBudget({
      messages: [...sent.messages, generated, { role: 'tool', content: 'x'.repeat(3400) }],
      model,
      tools,
      anchor: anchorFor(sent),
      estimateScale: 0.5,
    });
    expect(budget.used).toBe(155_032);
    expect(budget.extraMarginTokens).toBe(1032);
  });

  it.each(['compaction', 'trim', 'image stripping'])(
    'falls back to the scaled whole prompt after %s changes the prefix',
    (change) => {
      const sent = request();
      sent.messages[1]!.content = [
        { type: 'text', text: 'Review the source.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,image' } },
      ];
      const anchor = anchorFor(sent);
      if (change === 'compaction') sent.messages.shift();
      else if (change === 'trim') sent.messages[0]!.content = 'Shortened.';
      else sent.messages[1]!.content = 'Review the source. [image stripped]';
      const messages = [...sent.messages, generated];
      const budget = computeContextBudget({
        messages,
        model,
        tools,
        toolTokens: estimateToolTokens(tools),
        anchor,
        estimateScale: 1.25,
      });
      expect(budget.used).toBe(
        Math.ceil(
          (estimateTokens(messages) + estimateToolTokens(tools) + SYSTEM_AND_TEMPLATE_OVERHEAD) *
            1.25,
        ),
      );
      expect(budget.extraMarginTokens).toBe(0);
    },
  );

  it('freezes the request prefix before streamed output or in-place edits can change it', () => {
    const sent = request();
    const snapshot = snapshotPromptRequest(sent);
    const originalPrefix = JSON.stringify(sent.messages);
    sent.messages[1]!.content = 'Rewritten in place.';
    sent.messages.push(generated);
    sent.tools![0]!.function.description = 'Changed schema.';
    expect(snapshot.messageCount).toBe(2);
    expect(snapshot.prefix).toBe(originalPrefix);
    expect(snapshot.tools).toBe(JSON.stringify(tools));
  });

  it.each(['different model', 'changed tools', 'no assistant', 'same request'])(
    'rejects a stale anchor with %s',
    (change) => {
      const sent = request();
      const messages = [...sent.messages];
      if (change !== 'same request')
        messages.push(
          change === 'no assistant' ? { role: 'user', content: 'Continue.' } : generated,
        );
      const input = {
        messages,
        model: change === 'different model' ? { ...model, name: 'other' } : model,
        tools: change === 'changed tools' ? [] : tools,
        toolTokens: estimateToolTokens(tools),
        estimateScale: 1.2,
      };
      expect(computeContextBudget({ ...input, anchor: anchorFor(sent) })).toEqual(
        computeContextBudget(input),
      );
    },
  );

  it('updates scale from the whole sent prompt even after the previous budget used an anchor', () => {
    const state: { promptEstimateScale?: number; promptAnchor?: PromptAnchor } = {};
    const tracker = createOutputBudgetTracker(state, model);
    const sent = request();
    const initial = snapshotPromptRequest(sent);
    tracker.onUsage(
      { prompt_tokens: initial.estimatedPrompt * 1.2, completion_tokens: 4000 },
      initial,
    );
    const messages = [
      ...sent.messages,
      generated,
      { role: 'tool' as const, content: 'x'.repeat(3400) },
    ];
    expect(tracker.getOutputRoom(messages, tools).extraMarginTokens).toBe(1232);
    const next = snapshotPromptRequest({ ...sent, messages });
    tracker.onUsage({ prompt_tokens: next.estimatedPrompt * 1.1, completion_tokens: 1000 }, next);
    expect(state.promptEstimateScale).toBeCloseTo(1.1);
    expect(state.promptAnchor?.prefix).toBe(JSON.stringify(messages));
    expect(state.promptAnchor?.completionTokens).toBe(1000);
  });

  it('reuses runtime state across turns and starts without an anchor after reload', () => {
    const state: { promptEstimateScale?: number; promptAnchor?: PromptAnchor } = {};
    const sent = request();
    createOutputBudgetTracker(state, model).onUsage(
      { prompt_tokens: 150_000, completion_tokens: 4000 },
      snapshotPromptRequest(sent),
    );
    const messages = [...sent.messages, generated];
    expect(createOutputBudgetTracker(state, model).getOutputRoom(messages, tools)).toEqual({
      outputRoom: 45_984,
      extraMarginTokens: 16,
      used: 154_016,
    });
    expect(
      createOutputBudgetTracker({}, model).getOutputRoom(messages, tools).extraMarginTokens,
    ).toBe(0);
  });

  it('distinguishes an exhausted known context from an unknown context window', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(650_000) }];
    expect(createOutputBudgetTracker({}, model).getOutputRoom(messages, []).outputRoom).toBe(0);
    const unknown = { name: 'cloud', provider: 'openai' } as ModelConfig;
    expect(
      createOutputBudgetTracker({}, unknown).getOutputRoom(messages, []).outputRoom,
    ).toBeUndefined();
    expect(createOutputBudgetTracker({}, unknown).getOutputRoom(messages, []).used).toBeUndefined();
  });
});

describe('computeContextBudget', () => {
  const model = {
    name: 'm',
    num_ctx: 49152,
    spawn: {
      n_parallel: 1,
      extra_llama_server_args: ['--reasoning-budget', '8192'],
    },
  } as ModelConfig;

  it('reports the full generation room and the reserve-adjusted headroom separately', () => {
    const { used, max, outputRoom, headroom } = computeContextBudget({
      messages: [{ role: 'user', content: 'x'.repeat(4000) }],
      toolTokens: 3000,
      model,
    });
    expect(max).toBe(49152);
    expect(used).toBe(Math.ceil(4000 / CHARS_PER_TOKEN) + 3000 + SYSTEM_AND_TEMPLATE_OVERHEAD);
    // outputRoom is what max_tokens must be: the model spends thinking out of
    // it too, so subtracting the reserve here would double-count it.
    expect(outputRoom).toBe(49152 - used);
    // headroom is what is left for the answer once thinking has had its share.
    expect(headroom).toBe(49152 - used - 8192);
  });

  it('reports no headroom when the window is unknown', () => {
    const budget = computeContextBudget({
      messages: [{ role: 'user', content: 'hi' }],
      model: { name: 'gpt', provider: 'openai' } as ModelConfig,
    });
    expect(budget.max).toBe(0);
    expect(budget.outputRoom).toBe(0);
    expect(budget.headroom).toBe(0);
  });

  it('never goes negative once the prompt has overrun the window', () => {
    const budget = computeContextBudget({
      messages: [{ role: 'user', content: 'x'.repeat(400000) }],
      model,
    });
    expect(budget.headroom).toBe(0);
    expect(budget.outputRoom).toBe(0);
  });
});

describe('reportedContextTokens', () => {
  it('sums prompt and completion, because the completion becomes prompt next round', () => {
    expect(reportedContextTokens({ last_input_tokens: 12_000, last_output_tokens: 345 })).toBe(
      12_345,
    );
  });

  it('is 0 before any response, rather than falling back to an estimate', () => {
    expect(reportedContextTokens({})).toBe(0);
  });

  it('tolerates a half-populated record from an older session file', () => {
    expect(reportedContextTokens({ last_input_tokens: 900 })).toBe(900);
    expect(reportedContextTokens({ last_output_tokens: 40 })).toBe(40);
  });
});

describe('promptEstimateScale', () => {
  // Strata, 2026-10-01: ~113K estimated against 121,867 tokenized.
  it('tightens the next estimate by how far the last one fell short', () => {
    expect(promptEstimateScale(113_000, 121_867)).toBeCloseTo(1.078, 3);
  });

  it('never loosens, never runs away, and ignores missing counts', () => {
    expect(promptEstimateScale(100_000, 60_000)).toBe(1);
    expect(promptEstimateScale(10_000, 90_000)).toBe(1.5);
    expect(promptEstimateScale(0, 5_000)).toBeUndefined();
    expect(promptEstimateScale(5_000, 0)).toBeUndefined();
  });

  it('shrinks the output room computeContextBudget reports', () => {
    const model = { name: 'm', num_ctx: 154_624, spawn: { n_parallel: 1 } } as ModelConfig;
    const messages = [{ role: 'user' as const, content: 'x'.repeat(310_000) }];
    const plain = computeContextBudget({ messages, model });
    const scaled = computeContextBudget({ messages, model, estimateScale: 1.08 });
    expect(scaled.used).toBe(Math.ceil(plain.used * 1.08));
    expect(scaled.outputRoom).toBe(154_624 - scaled.used);
  });
});
