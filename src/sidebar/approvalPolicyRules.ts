/**
 * Policy-side approval rules. The key matcher is shared with chat rules; this
 * module supplies policy precedence and the attended/unattended scope around it.
 */
import { addApprovalAlwaysRules, type ForgeWriteOptions } from '../config/ConfigWriter';
import type { ForgeConfig } from '../config/types';
import {
  approvalKeysText,
  keyPathOf,
  ruleCovers,
  type ApprovalKeyContext,
  type ApprovalRequirement,
} from './approvalKey';
import { foldCase } from './approvalKeyGrammar';
import { describeApprovalKeys } from './approvalKeyWords';

export type ApprovalPolicyDecision =
  | { kind: 'allowed'; key: string }
  | { kind: 'denied'; allowPath: string }
  | { kind: 'none' };

/** Policy rules are first in the order: a project-wide owner rule answers before
 *  a chat rule or Clanker. Unattended work has no human at its card, so an
 *  unmatched key is denied with the one policy list that could allow it. */
export function approvalPolicyDecision(
  approvals: ForgeConfig['approvals'],
  requirements: readonly ApprovalRequirement[],
  context: ApprovalKeyContext,
  workspaceRoot: string | undefined,
  unattended: boolean,
  jobId?: string,
): ApprovalPolicyDecision {
  if (requirements.length === 0) return { kind: 'none' };
  const always = approvals?.always ?? [];
  if (
    requirements.every((requirement) =>
      always.some(
        (rule) =>
          workspaceMatches(rule.workspace, workspaceRoot, context) &&
          ruleCovers(rule.key, requirement, context),
      ),
    )
  ) {
    return { kind: 'allowed', key: approvalKeysText({ kind: 'keyed', requirements }) };
  }
  if (!unattended) return { kind: 'none' };

  const allowPath = jobId ? `approvals.jobs.${jobId}.allow` : 'approvals.unattended_bus.allow';
  const allowed = jobId
    ? (approvals?.jobs?.[jobId]?.allow ?? [])
    : (approvals?.unattended_bus?.allow ?? []);
  if (
    requirements.every((requirement) =>
      allowed.some((rule) => ruleCovers(rule, requirement, context)),
    )
  ) {
    return { kind: 'allowed', key: approvalKeysText({ kind: 'keyed', requirements }) };
  }
  return { kind: 'denied', allowPath };
}

/** The policy entries an owner sees in `/approvals`, limited to this workspace.
 *  A missing workspace means the owner made the entry apply everywhere. */
export function approvalPolicyLinesForWorkspace(
  approvals: ForgeConfig['approvals'],
  workspaceRoot: string | undefined,
  context: ApprovalKeyContext,
): string[] {
  return (approvals?.always ?? [])
    .filter((rule) => workspaceMatches(rule.workspace, workspaceRoot, context))
    .map((rule) => `Always in this project: ${describeApprovalKeys([rule.key])}  (${rule.key})`)
    .sort((left, right) => left.localeCompare(right));
}

export type AlwaysApprovalWriteResult =
  | { kind: 'written' }
  | { kind: 'locked'; message: string }
  | { kind: 'failed'; message: string };

/** Save only an owner button's decision. The model has no route to this function;
 *  ConfigWriter routes the `approvals` policy key and enforces policy.yaml's lock. */
export function writeApprovalAlways(
  configPath: string | undefined,
  keys: readonly string[],
  workspaceRoot: string | undefined,
  writerOptions: ForgeWriteOptions = {},
): AlwaysApprovalWriteResult {
  if (!configPath) return { kind: 'failed', message: 'The Forge config path is unavailable.' };
  if (!workspaceRoot) return { kind: 'failed', message: 'No workspace is open for this chat.' };
  try {
    addApprovalAlwaysRules(
      configPath,
      keys.map((key) => ({ key, workspace: workspaceRoot })),
      writerOptions,
    );
    return { kind: 'written' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Unlock policy.yaml')) {
      return { kind: 'locked', message: 'Unlock policy.yaml to save this project rule.' };
    }
    return { kind: 'failed', message };
  }
}

function workspaceMatches(
  ruleWorkspace: string | undefined,
  activeWorkspace: string | undefined,
  context: ApprovalKeyContext,
): boolean {
  if (ruleWorkspace === undefined) return true;
  if (activeWorkspace === undefined) return false;
  const rulePath = keyPathOf(ruleWorkspace, context);
  const activePath = keyPathOf(activeWorkspace, context);
  return (
    rulePath !== undefined &&
    activePath !== undefined &&
    foldCase(rulePath, context) === foldCase(activePath, context)
  );
}
