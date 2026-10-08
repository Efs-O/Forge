import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardedFetchResource, makeWebFetchTool } from '../../src/tools/fetchTool';

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
    ['IPv4-compatible private address', '::a00:1'],
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

  it('centres the max_chars window on the first match and reports no-match windows', async () => {
    const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    const fetch = vi.fn(async () =>
      new Response('0123456789NeedleABCDEFGHIJ', {
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const tool = makeWebFetchTool({ lookup, fetch });
    const matched = await tool.handler({
      url: 'https://public.example.test/',
      find: 'needle',
      max_chars: 10,
    });
    expect(matched).toMatch(/match offset 10/iu);
    expect(matched).toContain('total length 26');
    expect(matched).toContain('89NeedleAB');

    const absent = await tool.handler({
      url: 'https://public.example.test/',
      find: 'missing',
      max_chars: 4,
    });
    expect(absent).toMatch(/no match/iu);
    expect(absent).toContain('0123');
  });

  it('allows max_chars through 100000 while keeping the default at 30000', async () => {
    const body = 'x'.repeat(110_000);
    const tool = makeWebFetchTool({
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetch: async () => new Response(body, { headers: { 'content-type': 'text/plain' } }),
    });
    const defaultResult = String(await tool.handler({ url: 'https://public.example.test/' }));
    expect(defaultResult).toContain('showing 30000 of 110000 characters');
    const expanded = String(await tool.handler({ url: 'https://public.example.test/', max_chars: 100_000 }));
    expect(expanded).toContain('showing 100000 of 110000 characters');
    expect(expanded.match(/x/g)).toHaveLength(100_000);
    expect(tool.definition.function.parameters.properties.max_chars).toMatchObject({ maximum: 100_000 });
    await expect(tool.handler({ url: 'https://public.example.test/', max_chars: 100_001 })).rejects.toThrow(
      /max_chars must be an integer from 1 to 100000; received 100001/,
    );
  });

  it('uses the same DNS guard for routed preview resources, including rebinding names', async () => {
    const lookup = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const fetch = vi.fn(async () => new Response('must not connect'));
    await expect(guardedFetchResource('https://public.example.test/script.js', {
      method: 'GET', maxBytes: 1024,
    }, { lookup, fetch })).rejects.toThrow(/blocked.*127\.0\.0\.1/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('supports POST and stops reading once a routed response exceeds its byte cap', async () => {
    const fetch = vi.fn(
      async (
        _url: string,
        _address: { address: string; family: number },
        init: { method: string; body?: Uint8Array },
      ) => {
      expect(init.method).toBe('POST');
      expect(init.body).toEqual(Buffer.from('payload'));
      return new Response('too large');
      },
    );
    const options = { lookup: async () => [{ address: '8.8.8.8', family: 4 }], fetch };
    await expect(guardedFetchResource('https://public.example.test/api', {
      method: 'POST', body: Buffer.from('payload'), maxBytes: 4,
    }, options)).rejects.toThrow(/response exceeds the 4 byte limit/);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
