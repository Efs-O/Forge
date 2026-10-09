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
