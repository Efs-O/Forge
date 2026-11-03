import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/ConfigWriter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/ConfigWriter')>()),
  addApprovalAlwaysRules: () => {
    throw new Error('Forge: policy.yaml is locked. Run "Forge: Unlock policy.yaml".');
  },
}));

import { writeApprovalAlways } from '../../src/sidebar/approvalPolicyRules';

describe('Always in this project policy lock', () => {
  it('surfaces the policy unlock instruction to the approval queue', () => {
    expect(writeApprovalAlways('config.yaml', ['cross_chat'], 'N:/ws/project')).toEqual({
      kind: 'locked',
      message: 'Unlock policy.yaml to save this project rule.',
    });
  });
});
