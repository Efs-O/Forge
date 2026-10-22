import { describe, expect, it } from 'vitest';
import { widenForStopButton } from '../../src/remote/TelegramStopButton';

const BLANK = '⠀';

describe('widenForStopButton', () => {
  it('leaves text alone when the message carries no Stop', () => {
    expect(widenForStopButton('Forge: completed.')).toBe('Forge: completed.');
    expect(widenForStopButton('Forge: completed.', { stopButton: false })).toBe('Forge: completed.');
  });

  it('pads the last line with Braille blanks to 38 code points', () => {
    const widened = widenForStopButton('Forge: working…', { stopButton: true });
    expect(widened).toBe(`Forge: working…${BLANK.repeat(23)}`);
    expect([...widened]).toHaveLength(38);
  });

  it('measures only the last line, in code points', () => {
    const text = `${'a'.repeat(60)}\n⏱ 🔧 read`;
    const widened = widenForStopButton(text, { stopButton: true });
    expect(widened.startsWith(text)).toBe(true);
    expect([...widened.slice(widened.lastIndexOf('\n') + 1)]).toHaveLength(38);
  });

  it('does not pad a last line that is already wide', () => {
    const text = 'x'.repeat(40);
    expect(widenForStopButton(text, { stopButton: true })).toBe(text);
  });

  it('never pushes a message over the 4096 limit', () => {
    const text = 'y'.repeat(4090);
    expect(widenForStopButton(`${text}\nok`, { stopButton: true })).toBe(`${text}\nok`);
  });
});
