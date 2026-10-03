import { describe, expect, it } from 'vitest';
import { codePointLength, sliceCodePoints } from '../../src/util/codePoints';

describe('codePointLength', () => {
  it('counts ASCII, astral and combining text as characters', () => {
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('plan')).toBe(4);
    // One emoji is two UTF-16 code units; the character count is what Telegram
    // and the tool schema mean by "characters".
    expect(codePointLength('🖼')).toBe(1);
    expect('🖼'.length).toBe(2);
    expect(codePointLength('🖼 γεια 123')).toBe(10);
    expect(codePointLength('👨‍👩‍👧')).toBe(5);
  });

  // The shipped implementation used `text.match(/./gu)?.length`, and `.` with
  // the `u` flag never matches a line terminator: a multi-line caption
  // under-counted and passed a limit it should have failed (audit F8).
  it('counts line terminators, which `.` with /gu never matches', () => {
    expect(codePointLength('a\nb')).toBe(3);
    expect(codePointLength('\r\n')).toBe(2);
    expect(codePointLength('\n'.repeat(5))).toBe(5);
    expect(codePointLength('a\r\nb')).toBe(4);
  });

  it('splits exactly at the Telegram caption limit in code points', () => {
    const atLimit = 'a'.repeat(1_021) + '\n\n\n'; // 1,024 including newlines
    expect(codePointLength(atLimit)).toBe(1_024);
    expect(codePointLength(`${atLimit}a`)).toBe(1_025);
    const emoji = '🖼'.repeat(1_024);
    // 2,048 UTF-16 units, but exactly 1,024 characters.
    expect(emoji.length).toBe(2_048);
    expect(codePointLength(emoji)).toBe(1_024);
    expect(codePointLength(`${emoji}🖼`)).toBe(1_025);
  });
});

describe('sliceCodePoints', () => {
  it('never cuts a surrogate pair in half', () => {
    expect(sliceCodePoints('🖼🖼🖼', 2)).toBe('🖼🖼');
    expect(sliceCodePoints('abc🖼', 4)).toBe('abc🖼');
    expect(sliceCodePoints('abc🖼', 3)).toBe('abc');
    expect(sliceCodePoints('🖼x', 1)).toBe('🖼');
    expect(sliceCodePoints('abcdef', 4)).toBe('abcd');
    expect(sliceCodePoints('abcdef', 0)).toBe('');
  });

  it('returns the whole string when it already fits', () => {
    const text = '🖼'.repeat(600);
    // 600 characters is 1200 UTF-16 units: a code-unit slice at 1024 would
    // split a pair, and this must not.
    expect(text.length).toBe(1200);
    expect(sliceCodePoints(text, 1024)).toBe(text);
    expect(sliceCodePoints(text, 3)).toBe('🖼🖼🖼');
  });
});
