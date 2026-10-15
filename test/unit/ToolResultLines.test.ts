import { describe, expect, it } from 'vitest';
import { foldConsecutiveLines } from '../../webview-ui/src/toolResultLines';

describe('foldConsecutiveLines', () => {
  it('adds a repeat count to identical adjacent lines', () => {
    expect(foldConsecutiveLines('same\nsame\nsame\nother')).toBe('same (×3)\nother');
  });

  it('does not fold equal lines separated by another line', () => {
    expect(foldConsecutiveLines('same\nother\nsame')).toBe('same\nother\nsame');
  });

  it('preserves single lines, blank lines and a trailing newline', () => {
    expect(foldConsecutiveLines('one\n\n\ntwo\n')).toBe('one\n\ntwo\n');
    expect(foldConsecutiveLines('')).toBe('');
  });
});
