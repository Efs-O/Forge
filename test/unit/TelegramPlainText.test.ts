import { describe, expect, it } from 'vitest';
import { plainTelegramText } from '../../src/remote/TelegramText';

describe('plainTelegramText', () => {
  it('drops bold, inline code, headings and fence lines', () => {
    const text = [
      '## What changed',
      '- **The Alt-key trick.** Use `AllowSetForegroundWindow` here.',
      '```csharp',
      'static bool WaitFg(IntPtr h) { return **p == 0; }',
      '```',
    ].join('\n');
    expect(plainTelegramText(text)).toBe(
      [
        'What changed',
        '- The Alt-key trick. Use AllowSetForegroundWindow here.',
        'static bool WaitFg(IntPtr h) { return **p == 0; }',
      ].join('\n'),
    );
  });

  it('leaves plain text alone', () => {
    const text = 'Forge approval: run npm test? 2 * 3 = 6';
    expect(plainTelegramText(text)).toBe(text);
  });
});
