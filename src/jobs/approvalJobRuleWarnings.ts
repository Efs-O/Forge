import type { ForgeConfig } from '../config/types';
import type { JobFile } from './jobSchema';

/** Name owner policy rules whose job definition no longer exists. */
export function staleApprovalJobRuleWarning(
  approvals: ForgeConfig['approvals'] | undefined,
  jobIds: readonly string[],
): string | undefined {
  const loaded = new Set(jobIds);
  const stale = Object.keys(approvals?.jobs ?? {})
    .filter((id) => !loaded.has(id))
    .sort();
  if (stale.length === 0) return undefined;
  return (
    `Forge warning: policy.yaml has approval rules for missing job id${stale.length === 1 ? '' : 's'}: ` +
    `${stale.join(', ')}. Remove them from approvals.jobs in ~/.forge/policy.yaml.`
  );
}

/** Avoid repeating the same load warning on every scheduler tick. */
export class ApprovalJobRuleWarnings {
  private previous: string | undefined;

  constructor(
    private readonly getApprovalPolicy: () => ForgeConfig['approvals'] | undefined,
    private readonly notify: (message: string) => void,
  ) {}

  observe(jobs: readonly JobFile[]): void {
    this.observeJobIds(jobs.map(({ job }) => job.id));
  }

  observeJobIds(jobIds: readonly string[]): void {
    const message = staleApprovalJobRuleWarning(this.getApprovalPolicy(), jobIds);
    if (message === this.previous) return;
    this.previous = message;
    if (message) this.notify(message);
  }
}

export function makeApprovalWarnings(
  getApprovalPolicy: () => ForgeConfig['approvals'] | undefined,
  notify: (message: string) => void,
): ApprovalJobRuleWarnings {
  return new ApprovalJobRuleWarnings(getApprovalPolicy, notify);
}
