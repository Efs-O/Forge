import { describe, expect, it } from 'vitest';
import { decideCodexApproval } from '../../src/agents/CodexApprovalPolicy';

describe('decideCodexApproval', () => {
  it('answers a permissions request with the requested profile, not a decision (U03-03)', () => {
    const permissions = { network: { enabled: true }, fileSystem: null };
    expect(decideCodexApproval('item/permissions/requestApproval', { permissions }).result).toEqual(
      { permissions, scope: 'turn' },
    );
  });

  it('accepts commands and file changes, and declines anything else', () => {
    expect(decideCodexApproval('item/commandExecution/requestApproval', {}).result).toEqual({
      decision: 'accept',
    });
    expect(decideCodexApproval('item/fileChange/requestApproval', {}).result).toEqual({
      decision: 'accept',
    });
    expect(decideCodexApproval('item/unknown/requestApproval', {}).result).toEqual({
      decision: 'decline',
    });
  });
});
