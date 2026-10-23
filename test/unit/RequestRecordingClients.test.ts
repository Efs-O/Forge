import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest, StreamChunk } from '../../src/llm/types';
import type { ModelConfig } from '../../src/config/types';
import { streamChatCompletion, type StreamHandlers } from '../../src/llm/OpenAIClient';
import { streamOllamaChatCompletion } from '../../src/llm/OllamaNativeClient';
import { requestStatsRow, type RequestCapture } from '../../src/sessions/requestStats';
import { RequestDumpWriter } from '../../src/sessions/requestDump';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-recording-clients-'));
const encoder = new TextEncoder();

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

function streamResponse(text: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function handlers(
  onRequestStats: (capture: RequestCapture) => void,
  events: string[],
): StreamHandlers {
  return {
    onToken: () => {},
    onDone: () => events.push('done'),
    onError: (error) => events.push(`error:${error.name}`),
    onRequestStats: (capture) => {
      events.push(`stats:${capture.stats.outcome}`);
      onRequestStats(capture);
    },
  };
}

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

async function readDump(conversationId: string): Promise<Record<string, unknown>> {
  await new Promise((resolve) => setTimeout(resolve, 25));
  const directory = path.join(root, conversationId);
  const filename = fs.readdirSync(directory).find((name) => name.endsWith('.json'));
  if (!filename) throw new Error(`no dump written for ${conversationId}`);
  return JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('request capture in model clients', () => {
  it('dumps the exact OpenAI and Ollama fetch bodies, without headers', async () => {
    const writer = new RequestDumpWriter(root, vi.fn());
    const dump = (conversationId: string) => (capture: RequestCapture): void => {
      writer.enqueue(
        {
          conversationId,
          request: capture.body,
          url: capture.url,
          model: capture.model,
          sentAtMs: capture.sentAtMs,
          stats: requestStatsRow(capture.stats, capture.model, capture.sentAtMs),
        },
        { maxBytes: 100_000, keepHours: 24 },
      );
    };

    const request: ChatCompletionRequest = {
      model: 'model-a',
      messages: [{ role: 'user', content: 'OpenAI body' }],
      stream: true,
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
        },
      ],
      stream_options: { include_usage: true },
    };
    const finalChunk: StreamChunk = {
      id: 'r1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      timings: { prompt_n: 7, predicted_n: 2, ignored: 'not stored' },
    };
    const openAIBody = [
      sse({ choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] }),
      sse(finalChunk),
      'data: [DONE]\n\n',
    ].join('');
    let sentOpenAI = '';
    const openAIEvents: string[] = [];
    await streamChatCompletion(
      'http://example.test',
      request,
      handlers(dump('openai-chat'), openAIEvents),
      undefined,
      'PRIVATE_AUTH_KEY',
      async (_url, init) => {
        sentOpenAI = String(init.body);
        expect((init.headers as Record<string, string>)['Authorization']).toBe(
          'Bearer PRIVATE_AUTH_KEY',
        );
        return streamResponse(openAIBody);
      },
    );
    expect(openAIEvents).toEqual(['stats:ok', 'done']);
    expect(openAIEvents).toHaveLength(2);
    const openAIDump = await readDump('openai-chat');
    expect(openAIDump['request']).toEqual(JSON.parse(sentOpenAI));
    const openAIText = JSON.stringify(openAIDump);
    expect(openAIText).not.toContain('PRIVATE_AUTH_KEY');
    expect(openAIDump).not.toHaveProperty('headers');
    expect(openAIDump['url']).toBe('/v1/chat/completions');
    const openAIStats = openAIDump['stats'] as RequestCapture['stats'];
    expect(openAIStats.client.chunks).toBe(3);
    expect(openAIStats.client.first_token_ms).toBeLessThanOrEqual(openAIStats.client.total_ms);

    const ollamaRequest: ChatCompletionRequest = {
      ...request,
      model: 'ollama-model',
      messages: [{ role: 'user', content: 'Ollama body' }],
      stream_options: undefined,
    };
    const ollamaModel = {
      name: 'ollama-model',
      provider: 'ollama',
      endpoint: 'http://example.test',
    } as ModelConfig;
    let sentOllama = '';
    const ollamaEvents: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        sentOllama = String(init?.body);
        return streamResponse(
          [
            JSON.stringify({ message: { content: 'answer' }, done: false }),
            JSON.stringify({
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 10,
              eval_count: 3,
              load_duration: 1_100_000,
              prompt_eval_duration: 2_200_000,
              eval_duration: 3_300_000,
              total_duration: 4_400_000,
            }),
            '',
          ].join('\n'),
        );
      }),
    );
    await streamOllamaChatCompletion(
      'http://example.test',
      ollamaRequest,
      ollamaModel,
      handlers(dump('ollama-chat'), ollamaEvents),
    );
    expect(ollamaEvents).toEqual(['stats:ok', 'done']);
    const ollamaDump = await readDump('ollama-chat');
    expect(ollamaDump['request']).toEqual(JSON.parse(sentOllama));
    expect(ollamaDump['url']).toBe('/api/chat');
    expect(ollamaDump).not.toHaveProperty('headers');
    expect((ollamaDump['stats'] as RequestCapture['stats']).client.chunks).toBe(2);
    expect(ollamaDump['stats']).toMatchObject({
      ollama: { load_ms: 1.1, prompt_eval_ms: 2.2, eval_ms: 3.3, total_ms: 4.4 },
    });
  });

  it('emits one stats event before completion or failure for ok, aborted and error outcomes', async () => {
    const outcomes: Array<{ outcome: string; kind: 'ok' | 'abort' | 'error' }> = [
      { outcome: 'ok', kind: 'ok' },
      { outcome: 'aborted', kind: 'abort' },
      { outcome: 'error', kind: 'error' },
    ];
    for (const item of outcomes) {
      const events: string[] = [];
      const capture = vi.fn((recorded: RequestCapture) => events.push(`callback:${recorded.stats.outcome}`));
      const fetchImpl = async (): Promise<Response> => {
        if (item.kind === 'abort') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (item.kind === 'error') throw new Error('transport failed');
        return streamResponse('data: [DONE]\n\n');
      };
      await streamChatCompletion(
        'http://example.test',
        { model: 'm', messages: [], stream: true },
        handlers(capture, events),
        undefined,
        undefined,
        fetchImpl,
      );
      expect(capture).toHaveBeenCalledTimes(1);
      expect(events[0]).toBe(`stats:${item.outcome}`);
      expect(events[1]).toBe(`callback:${item.outcome}`);
      expect(events[2]).toMatch(item.kind === 'error' ? /^error:/u : /^done$/u);
    }
  });

  it('marks an incomplete length-finished tool call as truncated before onError', async () => {
    const events: string[] = [];
    const capture = vi.fn((recorded: RequestCapture) => events.push(`callback:${recorded.stats.outcome}`));
    await streamChatCompletion(
      'http://example.test',
      { model: 'm', messages: [], stream: true },
      handlers(capture, events),
      undefined,
      undefined,
      async () =>
        streamResponse(
          [
            sse({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call-1', function: { name: 'write_file', arguments: '{' } },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
            sse({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
          ].join(''),
        ),
    );

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0].stats).toMatchObject({
      outcome: 'truncated',
      finishReason: 'length',
    });
    expect(events[0]).toBe('stats:truncated');
    expect(events[1]).toBe('callback:truncated');
    expect(events[2]).toMatch(/^error:ToolCallTruncatedError$/u);
  });

  it('records Ollama aborts and frame errors before the terminal handler', async () => {
    const model = {
      name: 'ollama-model',
      provider: 'ollama',
      endpoint: 'http://example.test',
    } as ModelConfig;
    for (const outcome of ['aborted', 'error'] as const) {
      const events: string[] = [];
      const capture = vi.fn((recorded: RequestCapture) =>
        events.push(`callback:${recorded.stats.outcome}`),
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          if (outcome === 'aborted') {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          }
          return streamResponse('{"error":"frame failed"}\n');
        }),
      );
      await streamOllamaChatCompletion(
        'http://example.test',
        { model: 'ollama-model', messages: [], stream: true },
        model,
        handlers(capture, events),
      );

      expect(capture).toHaveBeenCalledTimes(1);
      expect(events[0]).toBe(`stats:${outcome}`);
      expect(events[1]).toBe(`callback:${outcome}`);
      expect(events[2]).toMatch(outcome === 'error' ? /^error:/u : /^done$/u);
    }
  });
});
