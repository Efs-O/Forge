import { describe, expect, it } from 'vitest';
import { canUseThinkingKwargs } from '../../src/sidebar/turnModelBehavior';
import type { RuntimeModelCapabilities } from '../../src/backend/ModelCapabilities';
import type { ModelConfig } from '../../src/config/types';

/**
 * `canUseThinkingKwargs` gates every thinking kwarg a turn sends, so the
 * preserve-thinking default changed it: a local model with no `think` field and
 * no flag is now `true`, and a truncation-recovery round sends it
 * `enable_thinking: false` like every other usable model.
 */
describe('canUseThinkingKwargs', () => {
  it('is true for a llama.cpp model with no think field and no flag', () => {
    expect(canUseThinkingKwargs({ name: 'q' } as ModelConfig, undefined)).toBe(true);
  });

  it('is false when the runtime caps say the model does not think', () => {
    const caps = { likelySupportsThinking: false } as RuntimeModelCapabilities;
    expect(canUseThinkingKwargs({ name: 'q' } as ModelConfig, caps)).toBe(false);
  });

  it('is false for an ollama model that sets neither think nor the flag', () => {
    expect(canUseThinkingKwargs({ name: 'q', provider: 'ollama' } as ModelConfig, undefined)).toBe(
      false,
    );
  });
});
