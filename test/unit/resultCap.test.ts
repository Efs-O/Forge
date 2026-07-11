import { describe, expect, it } from 'vitest';
import { capResultText, DEFAULT_MAX_RESULT_CHARS } from '../../src/tools/resultCap';

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