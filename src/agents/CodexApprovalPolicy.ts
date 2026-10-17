export interface CodexApprovalDecision {
  /** The JSON-RPC `result` sent back; its shape depends on the request method. */
  result: Record<string, unknown>;
  status: string;
}

/**
 * Codex runs with `approval_policy="never"`, so it should never ask. This
 * exists for the requests that arrive anyway (an older CLI, a tool that asks
 * regardless): an unanswered request stalls the turn forever, so answer it the
 * way the unrestricted session implies — accept — rather than leaving it open.
 *
 * A permissions request is not answered with a `decision`: its response
 * (`PermissionsRequestApprovalResponse`, from `codex app-server
 * generate-json-schema`) requires the granted `permissions` profile. Forge
 * grants exactly the profile requested, for this turn only.
 */
export function decideCodexApproval(
  method: string,
  params: Record<string, unknown>,
): CodexApprovalDecision {
  if (method === 'item/commandExecution/requestApproval')
    return { result: { decision: 'accept' }, status: 'allowed command' };
  if (method === 'item/fileChange/requestApproval')
    return { result: { decision: 'accept' }, status: 'allowed file change' };
  if (method === 'item/permissions/requestApproval') {
    const requested = params['permissions'];
    const permissions = requested && typeof requested === 'object' ? requested : {};
    return { result: { permissions, scope: 'turn' }, status: 'allowed permission request' };
  }
  return { result: { decision: 'decline' }, status: 'denied unsupported approval request' };
}
