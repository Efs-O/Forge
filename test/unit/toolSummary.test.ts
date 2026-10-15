import { describe, expect, it } from 'vitest';
import { extractToolDetail } from '../../src/sidebar/toolSummary';

describe('extractToolDetail', () => {
  it('labels delegation activity with the target model and focus', () => {
    expect(extractToolDetail('{"model":"qwen2.5-coder","focus":"security"}')).toBe(
      'qwen2.5-coder · security',
    );
  });

  it('labels delegation activity with the target model when focus is omitted', () => {
    expect(extractToolDetail('{"model":"qwen2.5-coder"}')).toBe('qwen2.5-coder');
  });

  it('shows every paths-array basename, up to three targets', () => {
    expect(
      extractToolDetail(
        JSON.stringify({ paths: ['src/a.ts', 'n:\\project\\b.ts', 'c.ts'] }),
      ),
    ).toBe('a.ts, b.ts, c.ts');
  });

  it('caps paths arrays after three basenames and reports the remaining count', () => {
    expect(
      extractToolDetail(
        JSON.stringify({ paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'] }),
      ),
    ).toBe('a.ts, b.ts, c.ts +2 more');
  });

  it('shows a string paths target as supplied', () => {
    expect(extractToolDetail(JSON.stringify({ paths: 'src/selected.ts' }))).toBe(
      'src/selected.ts',
    );
  });

  it('returns no target when paths is missing or empty', () => {
    expect(extractToolDetail(JSON.stringify({ recursive: true }))).toBe('');
    expect(extractToolDetail(JSON.stringify({ paths: [] }))).toBe('');
    expect(extractToolDetail(JSON.stringify({ paths: '' }))).toBe('');
  });

  it('marks a multi-edit target with its edit count', () => {
    expect(
      extractToolDetail(JSON.stringify({ path: 'src/app.ts', edits: [{}, {}, {}] })),
    ).toBe('app.ts · 3 edits');
    expect(extractToolDetail(JSON.stringify({ path: 'src/app.ts', edits: [{}] }))).toBe(
      'app.ts',
    );
  });

  it('keeps the complete executable and argument list for expandable tool details', () => {
    expect(
      extractToolDetail(
        JSON.stringify({ command: 'npm', args: ['run', 'test', '--', 'a very long pattern'] }),
      ),
    ).toBe('npm run test -- "a very long pattern"');
  });

  it('shows a shell command line as typed, without re-quoting it', () => {
    expect(
      extractToolDetail(JSON.stringify({ command: 'cd "n:/a b" && grep -n "fn" f.html' })),
    ).toBe('cd "n:/a b" && grep -n "fn" f.html');
  });
});
