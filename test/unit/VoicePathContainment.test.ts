import { describe, expect, it, vi } from 'vitest';
import { VoiceConfigSchema } from '../../src/config/voiceSchema';
import { PiperRunner } from '../../src/voice/PiperRunner';
import { VoiceOperation } from '../../src/voice/VoiceOperation';

describe('voice path containment', () => {
  it('accepts a voice identifier and rejects path syntax in config', () => {
    expect(VoiceConfigSchema.safeParse({ output: { voice_en: 'en_US-amy-medium' } }).success).toBe(
      true,
    );
    expect(VoiceConfigSchema.safeParse({ output: { voice_en: '../outside' } }).success).toBe(false);
  });

  it('rejects a traversal before Piper checks or reserves a model path', async () => {
    const operation = { reserve: vi.fn() } as unknown as VoiceOperation;
    const runner = new PiperRunner({ binary: 'piper', voicesDir: 'N:/voices' });

    await expect(runner.synthesize(operation, 'hello', '../outside')).rejects.toThrow(
      /safe voice identifier/,
    );
    expect(operation.reserve).not.toHaveBeenCalled();
  });

  it('refuses to reserve a file outside the private operation directory', async () => {
    const operation = await VoiceOperation.create();
    try {
      expect(() => operation.reserve('../outside.wav')).toThrow(/outside its directory/);
      const owned = operation.reserve('speech.wav');
      expect(owned).toMatch(/speech\.wav$/);
    } finally {
      await operation.dispose();
    }
  });
});
