import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolErrorText } from '../../src/tools/toolErrorText';

describe('toolErrorText enum issues', () => {
  it('names the allowed values and the received value', () => {
    const schema = z.object({ agent: z.enum(['claude', 'codex', 'copilot']) });
    const parsed = schema.safeParse({ agent: 'local' });
    if (parsed.success) throw new Error('Expected the enum value to be rejected.');

    expect(toolErrorText('ask_agent', parsed.error, { agent: 'local' })).toBe(
      'Error: ask_agent agent must be one of "claude", "codex", "copilot"; received "local".',
    );
  });
});
