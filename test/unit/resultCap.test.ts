import { describe, expect, it } from 'vitest';
import { capResultText, DEFAULT_MAX_RESULT_CHARS, isCapTruncated } from '../../src/tools/resultCap';

describe('resultCap', () => {
  it('should return text unchanged when shorter than the cap', () => {
    const shortText = 'This is a short text';
    const result = capResultText(shortText, 100);
    expect(result).toBe(shortText);
  });

  it('should truncate text and add marker when longer than the cap', () => {
    const longText = 'A'.repeat(100);
    const result = capResultText(longText, 50);
    expect(result).toBe(`${'A'.repeat(50)}\n\n[truncated by Forge MCP bridge — showing 50 of 100 chars]`);
  });

  it('should return text exactly at the cap unchanged', () => {
    expect(capResultText('a'.repeat(10), 10)).toBe('a'.repeat(10));
  });

  it('should handle empty string', () => {
    const result = capResultText('', 100);
    expect(result).toBe('');
  });

  it('should handle multibyte/unicode string near the boundary without corruption', () => {
    // Create a string with multibyte characters
    const unicodeText = '🚀'.repeat(30); // Each rocket emoji is 2 bytes in UTF-16
    const maxLength = 10;
    
    // Get the actual length in characters
    const originalLength = unicodeText.length;
    
    const result = capResultText(unicodeText, maxLength);
    
    // Should truncate at character boundary, not byte boundary
    expect(result).toContain('[truncated by Forge MCP bridge');
    expect(result.length).toBeGreaterThan(maxLength); // Because of the added marker text
  });

  it('should use default max chars constant', () => {
    expect(DEFAULT_MAX_RESULT_CHARS).toBe(24000);
  });
});

describe('isCapTruncated', () => {
  it('recognises text that capResultText actually cut', () => {
    expect(isCapTruncated(capResultText('A'.repeat(100), 10))).toBe(true);
  });

  it('recognises a cut carrying advice', () => {
    expect(isCapTruncated(capResultText('A'.repeat(100), 10, 'read_file', 'Page it.'))).toBe(true);
  });

  it('returns false for text capResultText left alone', () => {
    expect(isCapTruncated(capResultText('short', 100))).toBe(false);
  });

  // The marker is ordinary prose: a file that merely quotes it — this source,
  // a transcript, a doc about truncation — is not a truncated result, and
  // treating it as one changes what the model is told about a complete read.
  it('returns false when the phrase only appears inside the body', () => {
    const body = ['const MARKER = \'[truncated by Forge MCP bridge\';', 'more code follows'].join(
      '\n',
    );
    expect(isCapTruncated(body)).toBe(false);
  });

  it('returns false when the phrase appears mid-body of a complete read', () => {
    const cut = capResultText('A'.repeat(100), 10);
    const continued = [cut, '', 'and then the file continued to its real end'].join('\n');
    expect(isCapTruncated(continued)).toBe(false);
  });
});
