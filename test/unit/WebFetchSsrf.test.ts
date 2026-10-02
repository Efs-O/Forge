import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeWebFetchTool } from '../../src/tools/fetchTool';

describe('web_fetch DNS SSRF protection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects a public-looking host when any DNS answer is loopback', async () => {
    const lookup = vi.fn(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const fetch = vi.fn(async () => new Response('should not be fetched'));
    vi.stubGlobal('fetch', fetch);
    const tool = makeWebFetchTool({ lookup, fetch });

    await expect(tool.handler({ url: 'https://127.0.0.1.nip.io/' })).rejects.toThrow(
      /blocked.*127\.0\.0\.1/i,
    );
    expect(lookup).toHaveBeenCalledExactlyOnceWith('127.0.0.1.nip.io');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('re-resolves and rejects a redirect to a public-looking host that resolves privately', async () => {
    const lookup = vi.fn(async (hostname: string) =>
      hostname === 'public.example.test'
        ? [{ address: '8.8.8.8', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }],
    );
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://127.0.0.1.nip.io/private' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const tool = makeWebFetchTool({ lookup, fetch });

    await expect(tool.handler({ url: 'https://public.example.test/start' })).rejects.toThrow(
      /redirect target rejected.*127\.0\.0\.1/i,
    );
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenNthCalledWith(1, 'public.example.test');
    expect(lookup).toHaveBeenNthCalledWith(2, '127.0.0.1.nip.io');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://public.example.test/start',
      { address: '8.8.8.8', family: 4 },
      expect.any(Object),
      expect.anything(),
    );
  });

  it.each([
    ['CGNAT', '100.64.0.1'],
    ['IPv6 ULA', 'fd00::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
  ])('rejects DNS answers in the %s range', async (_name, address) => {
    const lookup = vi.fn(async () => [{ address, family: address.includes(':') ? 6 : 4 }]);
    const fetch = vi.fn(async () => new Response('should not be fetched'));
    vi.stubGlobal('fetch', fetch);
    const tool = makeWebFetchTool({ lookup, fetch });

    await expect(tool.handler({ url: 'https://public.example.test/' })).rejects.toThrow(/blocked/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes only the vetted address to the connection layer', async () => {
    const lookup = vi.fn(async () => [{ address: '1.1.1.1', family: 4 }]);
    const fetch = vi.fn(
      async () =>
        new Response('<p>public page</p>', {
          headers: { 'content-type': 'text/html' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const tool = makeWebFetchTool({ lookup, fetch });

    await expect(tool.handler({ url: 'https://public.example.test/' })).resolves.toContain(
      'public page',
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://public.example.test/',
      { address: '1.1.1.1', family: 4 },
      expect.any(Object),
      expect.anything(),
    );
  });
});
