export interface CodexApprovalDecision {
  decision: 'accept' | 'decline';
  status: string;
}

/**
 * Codex runs with `approval_policy="never"`, so it should never ask. This
 * exists for the requests that arrive anyway (an older CLI, a tool that asks
 * regardless): an unanswered request stalls the turn forever, so answer it the
 * way the unrestricted session implies — accept — rather than leaving it open.
 */
export function decideCodexApproval(
  method: string,
  params: Record<string, unknown>,
): CodexApprovalDecision {
  void params;
  if (method === 'item/commandExecution/requestApproval')
    return { decision: 'accept', status: 'allowed command' };
  if (method === 'item/fileChange/requestApproval')
    return { decision: 'accept', status: 'allowed file change' };
  if (method === 'item/permissions/requestApproval')
    return { decision: 'accept', status: 'allowed permission request' };
  return { decision: 'decline', status: 'denied unsupported approval request' };
}
