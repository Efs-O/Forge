import { describe, expect, it } from 'vitest';
import { RemoteSpeechDelivery } from '../../src/remote/RemoteSpeechDelivery';
import type { PiperRunner } from '../../src/voice/PiperRunner';
import type { RemoteChannel } from '../../src/remote/types';
import type { ForgeConfig } from '../../src/config/types';
import { voiceRuntimeSignature } from '../../src/remote/voiceRuntimeSignature';

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

  /**
   * The sender is on the phone: a failure that only raised a VS Code popup was
   * invisible, and replies simply arrived without audio.
   */
  it('reports the first speech failure to the chat, once', async () => {
    const sent: string[] = [];
    const piper = {
      async synthesize(): Promise<string> {
        throw new Error('piper exited 1');
      },
    } as unknown as PiperRunner;
    const channel = {
      name: 'telegram',
      async send(_chatId: string, text: string) {
        sent.push(text);
      },
      async sendVoice() {},
    } as unknown as RemoteChannel;
    const delivery = new RemoteSpeechDelivery(channel, piper, () => ({
      enabled: true,
      voiceEn: 'en_US-amy-medium',
      voiceEl: 'el_GR-joy-medium',
      maxChars: 600,
    }));

    const reply = 'The backend is running and every test passed on the first attempt.';
    await delivery.speak('42', reply);
    await delivery.speak('42', reply);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('piper exited 1');
  });

  it('says nothing while switched off', async () => {
    let called = false;
    const piper = {
      async synthesize(): Promise<string> {
        called = true;
        return 'x.wav';
      },
    } as unknown as PiperRunner;
    const channel = { name: 'telegram', async send() {}, async sendVoice() {} };
    const delivery = new RemoteSpeechDelivery(channel as unknown as RemoteChannel, piper, () => ({
      enabled: true,
      voiceEn: 'en_US-amy-medium',
      voiceEl: 'el_GR-joy-medium',
      maxChars: 600,
    }));
    delivery.setEnabled(false);

    expect(await delivery.speak('42', 'The backend is running and every test passed.')).toBe(false);
    expect(called).toBe(false);
  });

  /**
   * `/voice on|off` must take the in-place path: a rebuild disposed the
   * controller, and with it the auto-delete timers of the `/voice` command.
   */
  it('leaves output.enabled out of the rebuild signature', () => {
    const config = (enabled: boolean) =>
      ({
        voice: { enabled: true, output: { enabled, piper_binary: 'p', voices_dir: 'v' } },
      }) as unknown as ForgeConfig;
    expect(voiceRuntimeSignature(config(true))).toBe(voiceRuntimeSignature(config(false)));
  });
});
