import { describe, expect, it } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';

function parseTimeout(value: unknown) {
  return ForgeConfigSchema.safeParse({
    active_model: 'm',
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    permissions: { approval_timeout_minutes: value },
  });
}

describe('permissions.approval_timeout_minutes', () => {
  it('accepts the configured range and leaves the option absent by default', () => {
    expect(parseTimeout(1).success).toBe(true);
    expect(parseTimeout(1440).success).toBe(true);
    expect(
      ForgeConfigSchema.parse({
        active_model: 'm',
        models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
      }).permissions,
    ).toBeUndefined();
  });

  it('rejects zero, fractional, over-limit, and non-numeric values', () => {
    for (const value of [0, 1.5, 1441, '30']) {
      expect(parseTimeout(value).success, String(value)).toBe(false);
    }
  });
});
