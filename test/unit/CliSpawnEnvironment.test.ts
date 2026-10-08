import { describe, expect, it } from 'vitest';
import { buildCliSpawnEnvironment } from '../../src/agents/cliProcess';

describe('agent child environment', () => {
  it('strips session identity variables from inherited and adapter-provided values', () => {
    const environment = buildCliSpawnEnvironment({
      PATH: 'path-value',
      CLAUDE_CODE_SESSION_ID: 'parent-claude',
      CODEX_SESSION_ID: 'parent-codex',
      COPILOT_AGENT_SESSION_ID: 'parent-copilot',
    }, {
      CLAUDE_CODE_SESSION_ID: 'override-claude',
      CODEX_SESSION_ID: 'override-codex',
      COPILOT_AGENT_SESSION_ID: 'override-copilot',
      KEEP_ME: 'yes',
    });
    expect(environment).toEqual({ PATH: 'path-value', KEEP_ME: 'yes' });
  });
});
