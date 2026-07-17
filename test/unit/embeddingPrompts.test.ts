import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  DEFAULT_PROMPT_STYLE,
  formatDocument,
  formatQuery,
} from '../../src/search/embeddingPrompts';
import { EmbeddingClient } from '../../src/search/EmbeddingClient';

describe('embeddingPrompts', () => {
  it('defaults to none so non-Gemma models are unaffected', () => {
    expect(DEFAULT_PROMPT_STYLE).toBe('none');
  });

  it('passes text through unchanged under the none style', () => {
    expect(formatDocument('const a = 1;', 'none')).toBe('const a = 1;');
    expect(formatQuery('where is routing?', 'none')).toBe('where is routing?');
  });

  it('applies the Gemma document and query prefixes', () => {
    expect(formatDocument('const a = 1;', 'gemma')).toBe('title: none | text: const a = 1;');
    expect(formatQuery('where is routing?', 'gemma')).toBe(
      'task: code retrieval | query: where is routing?',
    );
  });

  it('gives documents and queries DIFFERENT prefixes', () => {
    // The asymmetry is the point: embedding a query as a document (the old
    // embedOne -> embedMany delegation) silently degrades ranking with no error.
    expect(formatDocument('x', 'gemma')).not.toBe(formatQuery('x', 'gemma'));
  });
});

describe('EmbeddingClient prompt roles', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(): { bodies: string[] } {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(init.body);
        const input = JSON.parse(init.body).input as string[];
        return {
          ok: true,
          json: async () => ({ data: input.map((_, index) => ({ index, embedding: [0.1, 0.2] })) }),
        };
      }),
    );
    return { bodies };
  }

  it('sends the document prefix for indexed content', async () => {
    const { bodies } = stubFetch();
    const client = new EmbeddingClient(
      () => 'http://127.0.0.1:8091',
      () => 'gemma',
    );
    await client.embedDocuments(['const a = 1;']);
    expect(JSON.parse(bodies[0]!).input).toEqual(['title: none | text: const a = 1;']);
  });

  it('sends the query prefix for searches', async () => {
    const { bodies } = stubFetch();
    const client = new EmbeddingClient(
      () => 'http://127.0.0.1:8091',
      () => 'gemma',
    );
    await client.embedQuery('where is routing?');
    expect(JSON.parse(bodies[0]!).input).toEqual([
      'task: code retrieval | query: where is routing?',
    ]);
  });

  it('sends raw text when no style provider is supplied', async () => {
    const { bodies } = stubFetch();
    const client = new EmbeddingClient(() => 'http://127.0.0.1:8091');
    await client.embedQuery('where is routing?');
    expect(JSON.parse(bodies[0]!).input).toEqual(['where is routing?']);
  });
});
