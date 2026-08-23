/**
 * Integration smoke tests: mock HTTP server → streamChatCompletion → ToolRegistry.
 * No VS Code API needed — exercises the pure-Node layers end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { streamChatCompletion } from '../../src/llm/OpenAIClient';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { ChatCompletionRequest } from '../../src/llm/types';

// ── Mock HTTP server helpers ──────────────────────────────────────────────────

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

// `listen(0)` may return a port that Fetch blocks even on loopback. Retry those
// WHATWG unsafe ports so this integration test cannot fail based on the OS's
// ephemeral-port choice.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
  102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
  427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
  989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6697, 10080,
]);

function startServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.once('error', reject);

    const listen = () => srv.listen(0, '127.0.0.1', onListening);
    const onListening = () => {
      const { port } = srv.address() as AddressInfo;
      if (FETCH_BLOCKED_PORTS.has(port)) {
        srv.close((error) => (error ? reject(error) : listen()));
        return;
      }
      const url = `http://127.0.0.1:${port}`;
      const close = () => new Promise<void>((res, rej) => srv.close((e) => (e ? rej(e) : res())));
      resolve({ url, close });
    };

    listen();
  });
}

function sseBody(events: string[]): Buffer {
  return Buffer.from(events.join('') + 'data: [DONE]\n\n');
}

function makeChunk(content: string, finishReason: string | null = null): string {
  const choice: Record<string, unknown> = {
    index: 0,
    delta: { content },
    finish_reason: finishReason,
  };
  return `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
}

/** SSE chunk with arbitrary delta (tests Ollama-style empty `finish_reason` or `reasoning_content`). */
function makeDeltaChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  const choice: Record<string, unknown> = {
    index: 0,
    delta,
    finish_reason: finishReason,
  };
  return `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
}

function makeToolChunk(
  index: number,
  id: string,
  name: string,
  args: string,
  finishReason: string | null = null,
): string {
  const choice: Record<string, unknown> = {
    index: 0,
    delta: {
      tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }],
    },
    finish_reason: finishReason,
  };
  return `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
}

const baseRequest: ChatCompletionRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
};

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('streamChatCompletion — basic token streaming', () => {
  let url: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sseBody([makeChunk('Hello'), makeChunk(', world!', 'stop')]));
    }));
  });

  afterAll(() => close());

  it('fires onToken for each chunk and onDone with stop', async () => {
    const tokens: string[] = [];
    let doneReason: string | null = 'PENDING' as unknown as null;

    await streamChatCompletion(url, baseRequest, {
      onToken: (t) => tokens.push(t),
      onDone: (r) => {
        doneReason = r;
      },
      onError: (e) => {
        throw e;
      },
    });

    expect(tokens).toEqual(['Hello', ', world!']);
    expect(doneReason).toBe('stop');
  });
});

describe('streamChatCompletion — empty-string finish_reason (Ollama interim chunks)', () => {
  let url: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const body = sseBody([
        makeDeltaChunk({}, ''),
        makeDeltaChunk({ content: 'Visible' }, 'stop'),
      ]);
      res.end(body);
    }));
  });

  afterAll(() => close());

  it('does not end stream until a non-empty finish_reason or [DONE]', async () => {
    const tokens: string[] = [];
    let doneReason: string | null = null;

    await streamChatCompletion(url, baseRequest, {
      onToken: (t) => tokens.push(t),
      onDone: (r) => {
        doneReason = r;
      },
      onError: (e) => {
        throw e;
      },
    });

    expect(tokens).toEqual(['Visible']);
    expect(doneReason).toBe('stop');
  });
});

describe('streamChatCompletion — reasoning_content when content is absent', () => {
  let url: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const body = sseBody([
        makeDeltaChunk({ reasoning_content: 'Step one. ' }, null),
        makeDeltaChunk({ content: 'Done.' }, 'stop'),
      ]);
      res.end(body);
    }));
  });

  afterAll(() => close());

  it('forwards reasoning_content as tokens', async () => {
    const tokens: string[] = [];
    await streamChatCompletion(url, baseRequest, {
      onToken: (t) => tokens.push(t),
      onDone: () => {},
      onError: (e) => {
        throw e;
      },
    });

    expect(tokens).toEqual(['Step one. ', 'Done.']);
  });
});

describe('streamChatCompletion — Ollama reasoning when content is absent', () => {
  let url: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const body = sseBody([
        makeDeltaChunk({ reasoning: 'Think first. ' }, null),
        makeDeltaChunk({ content: 'Done.' }, 'stop'),
      ]);
      res.end(body);
    }));
  });

  afterAll(() => close());

  it('forwards Ollama reasoning as tokens', async () => {
    const tokens: string[] = [];
    await streamChatCompletion(url, baseRequest, {
      onToken: (t) => tokens.push(t),
      onDone: () => {},
      onError: (e) => {
        throw e;
      },
    });

    expect(tokens).toEqual(['Think first. ', 'Done.']);
  });
});

describe('streamChatCompletion — tool_calls round-trip', () => {
  let url: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Single tool call streamed in two delta fragments, then finish.
      const body = sseBody([
        makeToolChunk(0, 'call-1', 'read_file', '{"path":"/tmp/f'),
        makeToolChunk(0, '', '', 'ile.txt"}', 'tool_calls'),
      ]);
      res.end(body);
    }));
  });

  afterAll(() => close());

  it('accumulates fragments and fires onToolCalls before onDone', async () => {
    const tokens: string[] = [];
    let toolCalls: { id: string; name: string; arguments: string }[] = [];
    let doneReason: string | null = null;

    await streamChatCompletion(url, baseRequest, {
      onToken: (t) => tokens.push(t),
      onDone: (r) => {
        doneReason = r;
      },
      onError: (e) => {
        throw e;
      },
      onToolCalls: (calls) => {
        toolCalls = calls.map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: c.function.arguments,
        }));
      },
    });

    expect(tokens).toHaveLength(0);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      id: 'call-1',
      name: 'read_file',
      arguments: '{"path":"/tmp/file.txt"}',
    });
    expect(doneReason).toBe('tool_calls');
  });
});

describe('streamChatCompletion — Ollama-style tool deltas with finish_reason stop', () => {
  let url: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const body = sseBody([
        makeToolChunk(0, 'call-ollama', 'write_new_file', '{"path":"/tmp/out.tx'),
        makeToolChunk(0, '', '', 't"}', 'stop'),
      ]);
      res.end(body);
    }));
  });

  afterAll(() => close());

  it('still fires onToolCalls when terminal finish_reason is stop (not tool_calls)', async () => {
    let toolCalls: { id: string; name: string; arguments: string }[] = [];
    let doneReason: string | null = null;

    await streamChatCompletion(url, baseRequest, {
      onToken: () => {},
      onDone: (r) => {
        doneReason = r;
      },
      onError: (e) => {
        throw e;
      },
      onToolCalls: (calls) => {
        toolCalls = calls.map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: c.function.arguments,
        }));
      },
    });

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      id: 'call-ollama',
      name: 'write_new_file',
      arguments: '{"path":"/tmp/out.txt"}',
    });
    expect(doneReason).toBe('stop');
  });
});

describe('streamChatCompletion — HTTP error surface', () => {
  let url: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ url, close } = await startServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Service Unavailable');
    }));
  });

  afterAll(() => close());

  it('calls onError with HTTP status when server returns non-200', async () => {
    let errorMsg = '';
    await streamChatCompletion(url, baseRequest, {
      onToken: () => {},
      onDone: () => {},
      onError: (e) => {
        errorMsg = e.message;
      },
    });
    expect(errorMsg).toMatch(/503/);
  });
});

describe('streamChatCompletion — AbortSignal cancellation', () => {
  let url: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Hang intentionally — the client will abort before we send anything.
      void res;
    }));
  });

  afterAll(() => close());

  it('resolves with "cancelled" when aborted before first byte', async () => {
    const ac = new AbortController();
    let doneReason: string | null = null;

    const promise = streamChatCompletion(
      url,
      baseRequest,
      {
        onToken: () => {},
        onDone: (r) => {
          doneReason = r;
        },
        onError: (e) => {
          throw e;
        },
      },
      ac.signal,
    );

    // Abort immediately.
    ac.abort();
    await promise;

    expect(doneReason).toBe('cancelled');
  });
});

describe('ToolRegistry — registration and dispatch', () => {
  it('dispatches a registered tool and returns its result', async () => {
    const registry = new ToolRegistry();
    registry.register({
      permission: 'read',
      definition: {
        type: 'function',
        function: {
          name: 'echo',
          description: 'Returns the input string',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      },
      handler: async (args) => String(args['text']),
    });

    const result = await registry.dispatch('echo', { text: 'ping' }, new Set(['read']));
    expect(result).toBe('ping');
  });

  it('throws on unknown tool', async () => {
    const registry = new ToolRegistry();
    await expect(registry.dispatch('nope', {}, new Set(['read']))).rejects.toThrow('unknown tool');
  });

  it('throws when required permission is not granted', async () => {
    const registry = new ToolRegistry();
    registry.register({
      permission: 'write',
      definition: {
        type: 'function',
        function: {
          name: 'w',
          description: '',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      mutation: { paths: () => [] },
      handler: async () => 'ok',
    });

    await expect(registry.dispatch('w', {}, new Set(['read']))).rejects.toThrow('permission');
  });

  it('filters definitions by allowed permission set', () => {
    const registry = new ToolRegistry();
    registry.register({
      permission: 'read',
      definition: {
        type: 'function',
        function: {
          name: 'r',
          description: '',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      handler: async () => '',
    });
    registry.register({
      permission: 'write',
      definition: {
        type: 'function',
        function: {
          name: 'w',
          description: '',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      mutation: { paths: () => [] },
      handler: async () => '',
    });

    const readOnly = registry.definitions(new Set(['read']));
    expect(readOnly.map((d) => d.function.name)).toEqual(['r']);

    const all = registry.definitions(new Set(['read', 'write']));
    expect(all.map((d) => d.function.name)).toEqual(['r', 'w']);
  });
});
