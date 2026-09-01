import React from 'react';
import { formatTokens } from '../../../src/util/formatTokens';

export interface WorkspaceInfo {
  name: string;
  path: string;
  extraRoots: number;
  stale: boolean;
}

interface Props {
  tokenUsed: number;
  tokenMax: number;
  workspace?: WorkspaceInfo | undefined;
}

function budgetColor(used: number, max: number): string {
  if (max === 0) return 'var(--vscode-progressBar-background, #0e70c0)';
  const pct = used / max;
  if (pct >= 0.9) return 'var(--vscode-errorForeground, #f48771)';
  if (pct >= 0.7) return 'var(--vscode-editorWarning-foreground, #cca700)';
  return 'var(--vscode-progressBar-background, #0e70c0)';
}

/**
 * Ambient conversation status: how full the context is.
 *
 * The model selector moved to the composer, where the choice is made, and the
 * typing dots moved to the single streaming line above the prompt — two
 * indicators firing off one `streaming` flag was redundant, and this row
 * collapsing and re-expanding around them shifted the transcript on every turn.
 * The budget stayed because it has to stay readable while scrolling, not only
 * when you look down to type.
 */
export function Header({ tokenUsed, tokenMax, workspace }: Props): React.ReactElement {
  const showBudget = tokenMax > 0;
  const fillPct = tokenMax > 0 ? Math.min(100, (tokenUsed / tokenMax) * 100) : 0;

  return (
    <div id="forge-header">
      {workspace && (
        <div
          id="workspace-root"
          className={workspace.stale ? 'stale' : undefined}
          title={[
            workspace.path || 'No folder is open - relative paths will not resolve.',
            workspace.extraRoots > 0
              ? `+${workspace.extraRoots} more folder(s); tools only use this first one.`
              : '',
            workspace.stale
              ? 'The folder list changed since Forge started. Reload the window so tools follow it.'
              : '',
          ]
            .filter(Boolean)
            .join('\n')}
        >
          <span id="workspace-root-name">{workspace.name || 'no folder'}</span>
          {workspace.extraRoots > 0 && (
            <span id="workspace-root-extra">+{workspace.extraRoots}</span>
          )}
          {workspace.stale && <span id="workspace-root-stale">reload needed</span>}
        </div>
      )}
      {showBudget && (
        <div
          id="token-budget"
          title={`${tokenUsed.toLocaleString()} / ${tokenMax.toLocaleString()} tokens used`}
        >
          <div id="token-budget-bar-track">
            <div
              id="token-budget-bar-fill"
              style={{ width: `${fillPct}%`, background: budgetColor(tokenUsed, tokenMax) }}
            />
          </div>
          <span id="token-budget-label">
            {formatTokens(tokenUsed)} / {formatTokens(tokenMax)}
          </span>
        </div>
      )}
    </div>
  );
}
