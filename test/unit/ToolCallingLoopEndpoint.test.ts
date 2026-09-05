import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';

interface Handlers {
  onToken: (t: string) => void;
  onDone: (finishReason: string | null) => void;
  onToolCalls: (calls: ToolCall[]) => void;
}

/**
 * The endpoint a turn calls is not fixed for the life of the turn.
 *
 * Forge's pool hands out a rotating port, and anything that unloads a model
 * mid-turn — a control-server /unload, an eviction, the benchmark freeing VRAM
 * — brings it back on the next free port behind a NEW controller. A loop that
 * captured the URL once then dialled a dead port and failed in ~11ms with
 * "fetch failed". That is what ended a two-hour monitoring turn on 2026-09-05:
 * the pool logged "slot ready … on port 8080" at 16:33:05 and the very next
 * request went to 8083, the port from the previous incarnation.
 */
describe('runToolCallingLoop endpoint resolution', () => {
  function twoRoundsThenStop(): void {
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      async (_url: string, _req: unknown, _model: unknown, h: Handlers) => {
        round += 1;
        if (round === 1) {
          h.onToolCalls([
            { id: 'c1', type: 'function', function: { name: 'edit_file', arguments: '{}' } },
          ]);
          h.onDone('tool_calls');
          return;
        }
        h.onToken('done');
        h.onDone('stop');
      },
    );
  }

  function options(resolveBaseUrl: () => Promise<string>) {
    return {
      resolveBaseUrl,
      model: { name: 'test-model' } as never,
      messages: [{ role: 'user', content: 'go' }] as ChatMessage[],
      getToolDefinitions: () => [{ type: 'function', function: { name: 'edit_file' } }] as never,
      dispatchToolCalls: async (calls: ToolCall[], msgs: ChatMessage[]) => {
        for (const c of calls) {
          msgs.push({ role: 'tool', content: 'ok', tool_call_id: c.id, name: 'edit_file' });
        }
      },
      signal: new AbortController().signal,
      maxRounds: 5,
      nativeTools: true,
    };
  }

  it('re-resolves the endpoint on every round, so a port change mid-turn lands', async () => {
    streamModelChatCompletion.mockReset();
    twoRoundsThenStop();
    const ports = ['http://127.0.0.1:8083', 'http://127.0.0.1:8080'];
    let call = 0;
    const resolve = vi.fn(async () => ports[Math.min(call++, ports.length - 1)]!);

    await runToolCallingLoop(options(resolve) as never);

    // One resolve per round, and round two followed the model to its new port
    // instead of re-dialling the dead one.
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(streamModelChatCompletion.mock.calls.map((c) => c[0])).toEqual([
      'http://127.0.0.1:8083',
      'http://127.0.0.1:8080',
    ]);
  });

  it('lets a round wait for a reload rather than failing against a dead port', async () => {
    streamModelChatCompletion.mockReset();
    twoRoundsThenStop();
    let reloaded = false;
    const resolve = vi.fn(async () => {
      // Stands in for pool.acquire() blocking on a restart: the second round
      // arrives mid-reload and must wait for it, not race past it.
      if (reloaded) return 'http://127.0.0.1:8080';
      await Promise.resolve();
      reloaded = true;
      return 'http://127.0.0.1:8083';
    });

    const result = await runToolCallingLoop(options(resolve) as never);

    expect(result.finishReason).toBe('stop');
    expect(streamModelChatCompletion.mock.calls.at(-1)?.[0]).toBe('http://127.0.0.1:8080');
  });
});
