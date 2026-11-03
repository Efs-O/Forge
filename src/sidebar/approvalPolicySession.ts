/** Keeps an owner-clicked policy rule effective in the current window immediately. */
import type { ForgeConfig } from '../config/types';

export function createApprovalPolicySession(options: {
  workspaceRoot?: string;
  getConfig?: () => ForgeConfig | undefined;
}): {
  rulesFor: (current: ForgeConfig['approvals']) => ForgeConfig['approvals'];
  rememberWritten: (keys: readonly string[]) => void;
} {
  const written: Array<{ key: string; workspace: string }> = [];
  const rememberWritten = (keys: readonly string[]): void => {
    const workspace = options.workspaceRoot;
    if (!workspace) return;
    const rules = keys.map((key) => ({ key, workspace }));
    for (const rule of rules) {
      if (!written.some((stored) => stored.key === rule.key && stored.workspace === rule.workspace))
        written.push(rule);
    }
    const config = options.getConfig?.();
    if (!config) return;
    const always = [...(config.approvals?.always ?? [])];
    for (const rule of rules) {
      if (!always.some((stored) => stored.key === rule.key && stored.workspace === rule.workspace))
        always.push(rule);
    }
    config.approvals = { ...config.approvals, always };
  };
  return {
    rulesFor: (current) => {
      const always = [...(current?.always ?? [])];
      for (const rule of written) {
        if (
          !always.some((stored) => stored.key === rule.key && stored.workspace === rule.workspace)
        )
          always.push(rule);
      }
      return current || always.length > 0 ? { ...current, always } : undefined;
    },
    rememberWritten,
  };
}
