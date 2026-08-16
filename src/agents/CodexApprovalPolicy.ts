import { checkDenyList, getBuiltinDenyList } from '../tools/DenyList';

export interface CodexApprovalDecision {
  decision: 'accept' | 'decline';
  status: string;
}

/**
 * The bounded-autonomy decision for Codex app-server approval requests.
 * Workspace confinement remains the primary boundary; this policy blocks known
 * destructive commands and every request to widen that boundary.
 */
export function decideCodexApproval(
  method: string,
  params: Record<string, unknown>,
): CodexApprovalDecision {
  if (method === 'item/commandExecution/requestApproval') {
    // Network-only and additional-permission requests use the command approval
    // method too, but omit a command. They must never be mistaken for a safe
    // empty command and silently widen the autonomous-workspace session.
    if (
      params['networkApprovalContext'] !== undefined ||
      params['additionalPermissions'] !== undefined
    ) {
      return { decision: 'decline', status: 'denied sandbox or network expansion' };
    }
    const command = params['command'];
    const commandText = Array.isArray(command)
      ? command.filter((part): part is string => typeof part === 'string').join(' ')
      : typeof command === 'string'
        ? command
        : '';
    const denied = checkDenyList(commandText, [], getBuiltinDenyList());
    return denied
      ? { decision: 'decline', status: `denied command: ${denied.description}` }
      : { decision: 'accept', status: 'allowed workspace command' };
  }
  if (method === 'item/fileChange/requestApproval') {
    return { decision: 'accept', status: 'allowed workspace file change' };
  }
  if (method === 'item/permissions/requestApproval') {
    return { decision: 'decline', status: 'denied sandbox or network expansion' };
  }
  return { decision: 'decline', status: 'denied unsupported approval request' };
}
