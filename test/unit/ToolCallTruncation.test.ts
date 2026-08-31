import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { CONTEXT_INPUT_EXHAUSTED_MESSAGE, runToolCallingLoop } from '../../src/agent/ToolCallingLoop';
import { ToolCallTruncatedError } from '../../src/llm/ToolCallTruncatedError';
import { ToolFailureTracker } from '../../src/tools/StripTools';

interface Handlers {
  onToken: (t: string) => void;
  onReasoning: (t: string) => void;
  onDone: (finishReason: string | null) => void;
  onToolCalls: (calls: ToolCall[]) => void;
  onError: (err: Error) => void;
}

/** The 500 llama-server returns when generation stopped mid-argument. */
const SERVER_TRUNCATION_500 =
  'HTTP 500: {"error":{"code":500,"message":"Failed to parse tool call arguments as JSON: ' +
  '[json.exception.parse_error.101] parse error at line 1, column 10509: syntax error while ' +
  'parsing value - invalid string: missing closing quote; last read: \'\\"use strict\\"\'"}}';

/** The same failure class for a call that is complete but structurally wrong. */
const SERVER_MALFORMED_500 =
  'HTTP 500: {"error":{"code":500,"message":"Failed to parse tool call arguments as JSON: ' +
  '[json.exception.parse_error.101] parse error at line 1, column 12: syntax error while ' +
  "parsing value - invalid literal; last read: 'nope'\"}}";

const SERVER_CONTEXT_400 =
  'HTTP 400: {"error":{"code":400,"message":"request (71277 tokens) exceeds the available context size (62208 tokens), try increasing it","type":"exceed_context_size_error"}}';

function runOptions(messages: ChatMessage[], extra: Record<string, unknown> = {}) {
  return {
    baseUrl: 'http://localhost:0',
    model: { name: 'test-model' } as never,
    messages,
    getToolDefinitions: () => [{ type: 'function', function: { name: 'write_file' } }] as never,
    dispatchToolCalls: async (calls: ToolCall[], msgs: ChatMessage[]) => {
      for (const c of calls) {
        msgs.push({ role: 'tool', content: 'ok', tool_call_id: c.id, name: c.function.name });
      }
    },
    signal: new AbortController().signal,
    maxRounds: 6,
    nativeTools: true,
    ...extra,
  };
}

describe('truncated tool calls', () => {
  beforeEach(() => {
    streamModelChatCompletion.mockReset();
  });

  it('maps llama-server input-context 400s to Forge recovery instead of a raw provider error', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
        h.onError(new Error(SERVER_CONTEXT_400));
      },
    );

    await expect(
      runToolCallingLoop(runOptions([{ role: 'user', content: 'continue' }]) as never),
    ).rejects.toThrow(CONTEXT_INPUT_EXHAUSTED_MESSAGE);
  });

  it('asks for the write in chunks instead of downgrading the model', async () => {
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
        round += 1;
        if (round === 1) {
          h.onError(
            new ToolCallTruncatedError({
              toolName: 'write_file',
              toolCallId: 'call_1',
              partialArguments: '{"path":"ui.js","content":"\\"use stri',
              approxBytes: 10509,
              finishReason: 'length',
            }),
          );
          return;
        }
        h.onToken('writing it in pieces');
        h.onDone('stop');
      },
    );

    const messages: ChatMessage[] = [{ role: 'user', content: 'split the file' }];
    const nativeFallback = vi.fn();
    const onTruncated = vi.fn();
    await runToolCallingLoop(
      runOptions(messages, {
        onNativeFallback: nativeFallback,
        onTruncatedToolCall: onTruncated,
      }) as never,
    );

    // The recovery must not look like "this model cannot do native tool calls".
    expect(nativeFallback).not.toHaveBeenCalled();
    expect(onTruncated).toHaveBeenCalledWith({ toolName: 'write_file', approxBytes: 10509 });

    const toolResult = messages.find((m) => m.role === 'tool');
    expect(toolResult?.tool_call_id).toBe('call_1');
    expect(toolResult?.content).toContain('was NOT executed');
    expect(toolResult?.content).toContain('append_file');
    // The unanswered call id is closed off so the next request stays valid.
    expect(messages.some((m) => m.role === 'assistant' && m.tool_calls?.length === 1)).toBe(true);
  });

  it('leaves tool calling enabled after repeated truncations', async () => {
    const tracker = new ToolFailureTracker();
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
        round += 1;
        if (round <= 2) {
          h.onError(
            new ToolCallTruncatedError({
              toolName: 'write_file',
              toolCallId: `call_${round}`,
              approxBytes: 9000,
              finishReason: 'length',
            }),
          );
          return;
        }
        h.onToken('smaller now');
        h.onDone('stop');
      },
    );

    await runToolCallingLoop(
      runOptions([{ role: 'user', content: 'go' }], { failureTracker: tracker }) as never,
    );
    // Running out of context is not the model failing at tool calls.
    expect(tracker.shouldStrip()).toBe(false);
  });

  it('fails the turn once recoveries are exhausted', async () => {
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
        h.onError(
          new ToolCallTruncatedError({
            toolName: 'write_file',
            toolCallId: 'call_x',
            approxBytes: 9000,
            finishReason: 'length',
          }),
        );
      },
    );
    await expect(
      runToolCallingLoop(runOptions([{ role: 'user', content: 'go' }]) as never),
    ).rejects.toThrow(/cannot hold it/);
  });

  it('classifies a truncation 500 as truncation, not as a native-tools failure', async () => {
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
        round += 1;
        if (round === 1) {
          h.onError(new Error(SERVER_TRUNCATION_500));
          return;
        }
        h.onToken('ok');
        h.onDone('stop');
      },
    );
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const nativeFallback = vi.fn();
    await runToolCallingLoop(runOptions(messages, { onNativeFallback: nativeFallback }) as never);
    expect(nativeFallback).not.toHaveBeenCalled();
    // No call id survives a whole-request failure, so the nudge goes in as a user turn.
    const nudge = messages.filter((m) => m.role === 'user').at(-1);
    expect(nudge?.content).toContain('append_file');
  });

  it('still falls back to the prompt tool format on a genuinely malformed call', async () => {
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
        round += 1;
        if (round === 1) {
          h.onError(new Error(SERVER_MALFORMED_500));
          return;
        }
        h.onToken('done');
        h.onDone('stop');
      },
    );
    const nativeFallback = vi.fn();
    const tracker = new ToolFailureTracker();
    await runToolCallingLoop(
      runOptions([{ role: 'user', content: 'go' }], {
        onNativeFallback: nativeFallback,
        failureTracker: tracker,
      }) as never,
    );
    expect(nativeFallback).toHaveBeenCalledOnce();
  });

  // Measured live: thinking took ~4k tokens before the tool call began, so a
  // retry that re-thinks starts with LESS room than the attempt that failed —
  // and cut at the identical byte three times running.
  it('turns thinking off for the retry so the whole budget goes to the write', async () => {
    const thinkFlags: unknown[] = [];
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      async (
        _url: string,
        req: { chat_template_kwargs?: { enable_thinking?: boolean } },
        _model: unknown,
        h: Handlers,
      ) => {
        round += 1;
        thinkFlags.push(req.chat_template_kwargs?.enable_thinking);
        if (round === 1) {
          h.onError(
            new ToolCallTruncatedError({
              toolName: 'write_file',
              toolCallId: 'call_1',
              approxBytes: 10509,
              finishReason: 'length',
            }),
          );
          return;
        }
        h.onToken('done');
        h.onDone('stop');
      },
    );

    await runToolCallingLoop(
      runOptions([{ role: 'user', content: 'go' }], {
        model: { name: 'test-model', think: true },
        canUseThinkingKwargs: true,
      }) as never,
    );
    expect(thinkFlags[0]).toBe(true);
    expect(thinkFlags[1]).toBe(false);
  });

  it('gives the retry a hard character ceiling, not just generic advice', async () => {
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
        round += 1;
        if (round === 1) {
          h.onError(
            new ToolCallTruncatedError({
              toolName: 'write_file',
              toolCallId: 'call_1',
              approxBytes: 10509,
              finishReason: 'length',
            }),
          );
          return;
        }
        h.onToken('ok');
        h.onDone('stop');
      },
    );
    const messages: ChatMessage[] = [{ role: 'user', content: 'write the whole file' }];
    await runToolCallingLoop(
      runOptions(messages, {
        getOutputRoom: () => 5000,
      }) as never,
    );
    const guidance = messages.find((m) => m.role === 'tool')?.content as string;
    // 5000 tokens of room would allow ~9000 chars, so the 6000-char tool
    // ceiling binds instead.
    expect(guidance).toContain('at most 6000 characters');
    // It has to outrank the user's own "write the whole file" instruction.
    expect(guidance).toContain('overrides any earlier instruction');
  });

  it('caps max_tokens to everything the model may still generate', async () => {
    const seen: number[] = [];
    streamModelChatCompletion.mockImplementation(
      async (_url: string, req: { max_tokens?: number }, _model: unknown, h: Handlers) => {
        seen.push(req.max_tokens ?? -1);
        h.onToken('hi');
        h.onDone('stop');
      },
    );
    await runToolCallingLoop(
      runOptions([{ role: 'user', content: 'go' }], {
        // outputRoom, not headroom: thinking is spent from max_tokens too, so
        // capping at the reserve-adjusted number double-counted the reserve.
        getOutputRoom: () => 3000,
      }) as never,
    );
    expect(seen[0]).toBe(3000 - 512);
  });

  it('never raises a deliberately small max_tokens', async () => {
    const seen: number[] = [];
    streamModelChatCompletion.mockImplementation(
      async (_url: string, req: { max_tokens?: number }, _model: unknown, h: Handlers) => {
        seen.push(req.max_tokens ?? -1);
        h.onToken('hi');
        h.onDone('stop');
      },
    );
    await runToolCallingLoop(
      runOptions([{ role: 'user', content: 'go' }], {
        maxOutputTokens: 256,
        getOutputRoom: () => 30000,
      }) as never,
    );
    expect(seen[0]).toBe(256);
  });
});
