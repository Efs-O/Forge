import { describe, expect, it } from 'vitest';
import { RemoteSpeechDelivery } from '../../src/remote/RemoteSpeechDelivery';
import type { PiperRunner } from '../../src/voice/PiperRunner';
import type { RemoteChannel } from '../../src/remote/types';

describe('RemoteSpeechDelivery', () => {
  /**
   * The bug this exists for: the one-time chat label was spoken along with the
   * answer, and its title is the sender's own first prompt. Every voice reply
   * opened by reading the question back, then an id letter by letter.
   */
  it('does not speak the one-time chat label', async () => {
    let spoken: string | undefined;
    const piper = {
      async synthesize(_operation: unknown, text: string): Promise<string> {
        spoken = text;
        throw new Error('captured');
      },
    } as unknown as PiperRunner;
    const channel = {
      name: 'telegram',
      async send() {},
      async sendVoice() {},
    } as unknown as RemoteChannel;
    const delivery = new RemoteSpeechDelivery(channel, piper, () => ({
      enabled: true,
      voiceEn: 'en_US-amy-medium',
      voiceEl: 'el_GR-joy-medium',
      maxChars: 600,
    }));

    const sent = await delivery.speak(
      '42',
      'Chat: Which llama build is Forge on · ID: 74a…d52\n\n' +
        'The backend is running and every test passed on the first attempt.',
    );

    expect(sent).toBe(false);
    expect(spoken).toBe('The backend is running and every test passed on the first attempt.');
    expect(spoken).not.toContain('74a');
  });
});
