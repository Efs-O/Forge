import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { disposeLocalLlamaFetch, localLlamaFetch } from '../../src/llm/localLlamaFetch';

// A real server, because the point is undici interop: Node's AbortSignal, the
// streamed body and the shared Agent all have to work outside the mocks.
describe('localLlamaFetch', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await disposeLocalLlamaFetch();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('waits for late headers like a queued llama-server and streams the body', async () => {
    const base = await listen((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: one\n\n');
        res.end('data: [DONE]\n\n');
      }, 300);
    });
    const init = { method: 'POST', body: '{}' };
    const first = await localLlamaFetch(`${base}/v1/chat/completions`, init);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('data: one\n\ndata: [DONE]\n\n');
    // The second request reuses the shared Agent.
    const second = await localLlamaFetch(`${base}/v1/chat/completions`, init);
    expect(await second.text()).toContain('[DONE]');
  });

  it('honours the caller abort signal while waiting for headers', async () => {
    const base = await listen(() => {
      // Never answers, like a request queued behind a busy slot.
    });
    const ctrl = new AbortController();
    const pending = localLlamaFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 100);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
