import { describe, expect, it } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';

const base = {
  active_model: 'cloud',
  models: [{ name: 'cloud', provider: 'ollama', endpoint: 'http://localhost:11434' }],
};

describe('voice server config', () => {
  it('rejects the old setting with an actionable replacement', () => {
    const result = ForgeConfigSchema.safeParse({
      ...base,
      voice: { enabled: false, keep_model_loaded: false },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('voice.server.enabled');
    }
  });

  it('requires the resident server binary when enabled', () => {
    const result = ForgeConfigSchema.safeParse({
      ...base,
      voice: {
        enabled: true,
        whisper_model: 'model.bin',
        server: { enabled: true },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'voice.server.binary')).toBe(
        true,
      );
    }
  });

  it('applies the documented resident defaults', () => {
    const result = ForgeConfigSchema.parse({
      ...base,
      voice: {
        enabled: true,
        whisper_model: 'model.bin',
        server: { enabled: true, binary: 'whisper-server.exe' },
      },
    });
    expect(result.voice?.server).toEqual({
      enabled: true,
      binary: 'whisper-server.exe',
      port: 8092,
      idle_timeout_ms: 600_000,
      confirm_on_start: true,
    });
  });

  it('keeps whisper-cli as the default and requires its binary', () => {
    const result = ForgeConfigSchema.safeParse({
      ...base,
      voice: { enabled: true, whisper_model: 'model.bin' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'voice.whisper_binary')).toBe(
        true,
      );
    }
  });
});
