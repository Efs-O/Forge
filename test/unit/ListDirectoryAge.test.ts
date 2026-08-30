import { describe, expect, it } from 'vitest';
import { formatAge } from '../../src/tools/listDirectoryTool';

describe('list_directory age formatting', () => {
  it('clamps normal filesystem clock skew but preserves genuine future timestamps', () => {
    expect(formatAge(-1)).toBe('0s ago');
    expect(formatAge(-2_000)).toBe('0s ago');
    expect(formatAge(-2_001)).toBe('modified in the future');
  });
});
