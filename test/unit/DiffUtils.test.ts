import { describe, expect, it } from 'vitest';
import { computeDiff } from '../../src/sidebar/DiffUtils';

const added = (before: string, after: string): number =>
  (computeDiff(before, after) ?? []).flatMap((h) => h.lines).filter((l) => l.kind === 'added').length;

describe('computeDiff line counts', () => {
  it('counts a new file by its lines, not its newlines plus one', () => {
    expect(added('', 'a\nb\nc\n')).toBe(3);
    expect(added('', 'a\nb\nc')).toBe(3);
  });

  it('counts an append as the appended lines only', () => {
    expect(added('a\nb\n', 'a\nb\nc\nd\n')).toBe(2);
  });

  it('reports identical text as no hunks', () => {
    expect(computeDiff('a\nb\n', 'a\nb\n')).toEqual([]);
  });
});
