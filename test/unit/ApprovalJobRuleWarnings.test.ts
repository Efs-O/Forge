import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import {
  ApprovalJobRuleWarnings,
  staleApprovalJobRuleWarning,
} from '../../src/jobs/approvalJobRuleWarnings';

describe('approval policy job warnings', () => {
  it('names stale job ids and ignores rules for loaded jobs', () => {
    const approvals = {
      jobs: {
        'removed-z': { allow: ['cross_chat'] },
        current: { allow: ['tool:git_commit'] },
        'removed-a': { allow: ['delegate:codex'] },
      },
    } as ForgeConfig['approvals'];

    expect(staleApprovalJobRuleWarning(approvals, ['current'])).toBe(
      'Forge warning: policy.yaml has approval rules for missing job ids: removed-a, removed-z. ' +
        'Remove them from approvals.jobs in ~/.forge/policy.yaml.',
    );
  });

  it('warns once for the same stale set and warns again after a clean load', () => {
    const approvals = { jobs: { removed: { allow: ['cross_chat'] } } } as ForgeConfig['approvals'];
    const notify = vi.fn();
    const warnings = new ApprovalJobRuleWarnings(() => approvals, notify);
    warnings.observeJobIds([]);
    warnings.observeJobIds([]);
    expect(notify).toHaveBeenCalledOnce();

    warnings.observeJobIds(['removed']);
    warnings.observeJobIds([]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('returns no warning when policy has no stale job id', () => {
    expect(staleApprovalJobRuleWarning({ jobs: {} }, [])).toBeUndefined();
    expect(
      staleApprovalJobRuleWarning({ jobs: { current: { allow: ['cross_chat'] } } }, ['current']),
    ).toBeUndefined();
  });
});
