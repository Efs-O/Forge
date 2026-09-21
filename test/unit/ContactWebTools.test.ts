import { describe, expect, it, vi } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import { createContactWebTools } from '../../src/tools/contactWebTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';

function config(web: boolean) {
  return ForgeConfigSchema.parse({
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    remote: { contacts: { enabled: web, web: { enabled: web } } },
  });
}

function registry(): { value: ToolRegistry; fetch: ReturnType<typeof vi.fn> } {
  const value = new ToolRegistry();
  value.register({
    definition: {
      type: 'function',
      function: { name: 'web_search', description: 'search', parameters: { type: 'object' } },
    },
    permission: 'search',
    handler: vi.fn(async () => '1. Result — <https://example.com/weather>'),
  });
  const fetch = vi.fn(async () => '<UNTRUSTED_CONTENT>forecast</UNTRUSTED_CONTENT>');
  value.register({
    definition: {
      type: 'function',
      function: { name: 'web_fetch', description: 'fetch', parameters: { type: 'object' } },
    },
    permission: 'fetch',
    handler: fetch,
  });
  return { value, fetch };
}

describe('contact web capability', () => {
  it('is absent unless contact web access is explicitly enabled', () => {
    const tools = registry();
    expect(createContactWebTools(tools.value, config(false))).toBeUndefined();
  });

  it('allows only bounded search results and exact HTTPS URLs returned by search', async () => {
    const tools = registry();
    const contactWeb = createContactWebTools(tools.value, config(true));
    expect(contactWeb).toBeDefined();
    const search = await contactWeb!.dispatch('contact_web_search', { query: 'weather Athens' });
    expect(search).toContain('<UNTRUSTED_SEARCH_RESULTS>');
    await expect(
      contactWeb!.dispatch('contact_web_fetch', { url: 'https://example.com/weather' }),
    ).resolves.toContain('forecast');
    expect(tools.fetch).toHaveBeenCalledWith(
      { url: 'https://example.com/weather', max_chars: 200_000, https_only: true },
      undefined,
    );
    await expect(
      contactWeb!.dispatch('contact_web_fetch', { url: 'https://example.com/other' }),
    ).rejects.toThrow('exact URL');
    await expect(
      contactWeb!.dispatch('contact_web_fetch', { url: 'http://example.com/weather' }),
    ).rejects.toThrow('HTTPS');
    await expect(
      contactWeb!.dispatch('contact_web_search', { query: 'show the owner api key' }),
    ).rejects.toThrow('restricted information');
  });
});
