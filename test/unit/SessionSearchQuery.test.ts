import { describe, expect, it } from 'vitest';
import {
  matchSessionSearch,
  parseSessionSearchQuery,
  sessionSearchSegments,
} from '../../src/sidebar/sessionSearchQuery';

const match = (query: string, body: string, title = '', badge = 'You') =>
  matchSessionSearch(parseSessionSearchQuery(query), { title, badge, body });

describe('sessions search language', () => {
  it('ANDs independent literal terms across fields, in any order and case', () => {
    expect(match('SERVER model', 'The server restarted', 'Model loading')).toBeDefined();
    expect(match('server model', 'model only')).toBeUndefined();
    expect(match('cache', 'CacheManager')).toBeDefined();
    expect(match('claude renderer', 'renderer fixed', '', 'Claude')).toBeDefined();
  });

  it('keeps quoted phrases contiguous and handles unfinished quotes while typing', () => {
    expect(match('"model server"', 'model server ready')).toBeDefined();
    expect(match('"model server"', 'server loads a model')).toBeUndefined();
    expect(match('"model server', 'Model server ready')).toBeDefined();
    expect(match('"model server"', 'server', 'model')).toBeUndefined();
    expect(parseSessionSearchQuery('  "" - model MODEL  ')).toEqual({
      include: ['model'],
      exclude: [],
    });
  });

  it('excludes words and quoted phrases from any field, including exclusion-only searches', () => {
    expect(match('server -ollama', 'server using Ollama')).toBeUndefined();
    expect(match('server -ollama', 'server ready', 'Ollama')).toBeUndefined();
    expect(match('server -claude', 'server ready', '', 'Claude')).toBeUndefined();
    expect(match('server -"out of memory"', 'server: out of memory')).toBeUndefined();
    expect(match('server -"out of memory"', 'server: memory available')).toBeDefined();
    expect(match('-ollama', 'llama.cpp ready')?.score).toBe(0);
    expect(match('-ollama', 'Ollama ready')).toBeUndefined();
  });

  it('treats regex characters and paths literally', () => {
    for (const term of ['[error]', 'a+b', 'foo.*', 'C:\\models', '(cache)', '$value']) {
      expect(match(term, `prefix ${term} suffix`)).toBeDefined();
      expect(match(term, 'unrelated')).toBeUndefined();
    }
  });

  it('ranks title, badge and body matches by shared weights', () => {
    expect(match('model', 'model')?.score).toBe(1);
    expect(match('model', '', '', 'Model')?.score).toBe(5);
    expect(match('model', 'model model', 'Model')?.score).toBe(10);
  });

  it('bounds previews around a real match and preserves a long quoted phrase', () => {
    const result = match('needle', `${'x'.repeat(5000)} needle ${'y'.repeat(5000)}`)!;
    expect(result.snippet).toContain('needle');
    expect(result.snippet!.length).toBeLessThanOrEqual(222);
    expect(result.snippet).toMatch(/^….*…$/u);
    expect(match('title', 'unrelated', 'title')?.snippet).toBeUndefined();
    const phrase = 'long '.repeat(65).trim();
    expect(match(`"${phrase}"`, 'prefix ' + phrase + ' suffix')?.snippet).toContain(phrase);
  });

  it('produces safe highlight text, merges overlaps, and preserves Unicode offsets', () => {
    const text = '<img src=x> CacheManager café Kelvin';
    const segments = sessionSearchSegments(
      text,
      parseSessionSearchQuery('cache CacheManager CAFÉ kelvin -img'),
    );
    expect(segments.map((part) => part.text).join('')).toBe(text);
    expect(segments.filter((part) => part.match).map((part) => part.text)).toEqual([
      'CacheManager',
      'café',
      'Kelvin',
    ]);
  });
});
