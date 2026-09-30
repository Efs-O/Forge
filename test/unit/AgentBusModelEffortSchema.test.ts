import { describe, expect, it } from 'vitest';
import { AgentBusConfigSchema } from '../../src/config/agentBusSchema';

/**
 * Side change A (TOOL_SURFACE_AND_SHELL_ACCESS_PLAN.md): four optional
 * `agent_bus` keys pick the model/effort for a Forge-owned Codex/Claude
 * session. No local allowlist of model names — only `codex_effort` is an
 * enum (Codex's own `model_reasoning_effort` values); `claude_model` and
 * `claude_effort` are free-form strings.
 */
describe('AgentBusConfigSchema: codex_model/codex_effort/claude_model/claude_effort', () => {
  it('parses all four keys unset (today\'s config keeps validating)', () => {
    const parsed = AgentBusConfigSchema.parse({});
    expect(parsed?.codex_model).toBeUndefined();
    expect(parsed?.codex_effort).toBeUndefined();
    expect(parsed?.claude_model).toBeUndefined();
    expect(parsed?.claude_effort).toBeUndefined();
  });

  it('parses all four keys set', () => {
    const parsed = AgentBusConfigSchema.parse({
      codex_model: 'gpt-6-luna',
      codex_effort: 'xhigh',
      claude_model: 'opus',
      claude_effort: 'max',
    });
    expect(parsed).toMatchObject({
      codex_model: 'gpt-6-luna',
      codex_effort: 'xhigh',
      claude_model: 'opus',
      claude_effort: 'max',
    });
  });

  it('rejects a codex_effort value outside the enum', () => {
    expect(() => AgentBusConfigSchema.parse({ codex_effort: 'ultra' })).toThrow();
  });

  it('accepts any non-empty claude_effort string (no local allowlist)', () => {
    const parsed = AgentBusConfigSchema.parse({ claude_effort: 'some-future-tier' });
    expect(parsed?.claude_effort).toBe('some-future-tier');
  });
});
