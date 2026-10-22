import { describe, expect, it } from 'vitest';
import { noticeEmoji, styleTelegramNotice } from '../../src/remote/telegramNoticeStyle';

describe('Telegram notice styling', () => {
  it('picks an emoji by the notice kind', () => {
    expect(noticeEmoji('Forge approval: run_command\nnpm test')).toBe('🔔');
    expect(noticeEmoji('Forge approval approved (user).')).toBe('✅');
    expect(noticeEmoji('Forge approval denied (timeout).')).toBe('🚫');
    expect(noticeEmoji('Forge asks: which backend?')).toBe('❓');
    expect(noticeEmoji('Seen by the running turn.')).toBe('👀');
    expect(noticeEmoji('Forge request failed: boom')).toBe('⚠️');
    expect(noticeEmoji('Forge request cancelled.')).toBe('🚫');
    expect(noticeEmoji('Forge: compaction complete.')).toBe('✅');
    expect(noticeEmoji('Forge: reloading the window…')).toBe('ℹ️');
  });

  it('leaves text that is not a Forge notice alone', () => {
    expect(styleTelegramNotice('Here is the diff you asked for.')).toBeUndefined();
    expect(styleTelegramNotice('Forgery is a crime.')).toBeUndefined();
  });

  it('escapes the notice inside a blockquote', () => {
    expect(styleTelegramNotice('Forge request failed: <tag> & more')).toBe(
      '<blockquote>⚠️ Forge request failed: &lt;tag&gt; &amp; more</blockquote>',
    );
  });

  it('strips only the display prefix from a generic Forge notice', () => {
    expect(styleTelegramNotice('Forge: Request failed: <tag>')).toBe(
      '<blockquote>⚠️ Request failed: &lt;tag&gt;</blockquote>',
    );
    expect(styleTelegramNotice('Forge: asks: <tag>')).toBe(
      '<blockquote>ℹ️ asks: &lt;tag&gt;</blockquote>',
    );
    expect(styleTelegramNotice('Forge approval: run_command\n<tag>')).toContain(
      'Forge approval: run_command',
    );
  });

  it('sends a notice that would split across messages plain', () => {
    expect(styleTelegramNotice(`Forge request failed: ${'x'.repeat(4100)}`)).toBeUndefined();
  });
});
