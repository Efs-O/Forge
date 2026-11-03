import * as http from 'http';
import * as net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTailnetListener, hostAllowed, isJsonContentType, originRefused } from '../../src/backend/TailnetListener';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listener did not bind');
  return address.port;
}

describe('TailnetListener', () => {
  let listener: ReturnType<typeof createTailnetListener> | undefined;
  afterEach(() => {
    listener?.dispose();
    listener = undefined;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('exports the shared Host, Origin and JSON checks', () => {
    expect(hostAllowed('127.0.0.1:8797')).toBe(true);
    expect(hostAllowed('desktop.tailnet')).toBe(false);
    expect(originRefused(undefined)).toBe(false);
    expect(originRefused('https://example.test')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('text/plain')).toBe(false);
  });

  it('binds only loopback and refuses names, Origins, non-JSON and oversized bodies', async () => {
    listener = createTailnetListener({
      port: 0,
      routes: ['POST /write'],
      maxBodyBytes: 8,
      label: 'TestTailnet',
      log,
      onRequest: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      },
    });
    const port = await new Promise<number>((resolve) => {
      const poll = (): void => {
        const address = listener?.boundAddress();
        if (address) resolve(address.port);
        else setTimeout(poll, 1);
      };
      poll();
    });
    expect(listener.boundAddress()?.address).toBe('127.0.0.1');
    const request = (headers: http.OutgoingHttpHeaders, body = '{}'): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/write', method: 'POST', headers },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    expect(await request({ host: 'desktop.tailnet', 'content-type': 'application/json' })).toBe(403);
    expect(await request({ origin: 'https://bad.test', 'content-type': 'application/json' })).toBe(403);
    expect(await request({ 'content-type': 'text/plain' })).toBe(415);
    expect(await request({ 'content-type': 'application/json' }, '{"large":1}')).toBe(413);
  });

  it('logs EADDRINUSE once, retries after 30 seconds, and clears the retry on dispose', async () => {
    const occupied = net.createServer();
    const port = await listen(occupied);
    vi.useFakeTimers();
    const warned = new Promise<void>((resolve) => log.warn.mockImplementationOnce(() => resolve()));
    listener = createTailnetListener({
      port,
      routes: ['GET /'],
      maxBodyBytes: 1,
      label: 'TestTailnet',
      log,
      onRequest: (_req, res) => res.end('ok'),
    });
    await warned;
    expect(log.warn).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(listener?.boundAddress()?.port).toBe(port));
    listener.dispose();
    listener = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
});
