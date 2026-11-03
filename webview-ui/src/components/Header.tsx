import React from 'react';
import { formatTokens } from '../../../src/util/formatTokens';

export interface WorkspaceInfo {
  name: string;
  path: string;
  extraRoots: number;
  stale: boolean;
  rootUri?: string;
  forgeIconUri?: string;
}

interface Props {
  tokenUsed: number;
  tokenMax: number;
  compactAt?: number | undefined;
  workspace?: WorkspaceInfo | undefined;
}

function budgetColor(used: number, max: number): string {
  if (max === 0) return 'var(--forge-green)';
  const pct = used / max;
  if (pct >= 0.9) return 'var(--vscode-errorForeground, #f48771)';
  if (pct >= 0.7) return 'var(--vscode-editorWarning-foreground, #cca700)';
  return 'var(--forge-green)';
}

/**
 * Ambient conversation status: where you are, and how full the context is.
 *
 * One row, not two. The workspace root and the budget were stacked, and the
 * budget's track spanned the panel to represent a number that is 0 for the first
 * minutes of a session - at rest it read as a stalled progress bar. Side by side
 * with a fixed-width track, the number is the element and the bar is the
 * qualifier, which is the right way round.
 *
 * The model selector lives in the composer, where the choice is made, and the
 * typing dots on the streaming line above the prompt - two indicators firing off
 * one `streaming` flag was redundant, and this row collapsing and re-expanding
 * around them shifted the transcript on every turn.
 */
export function Header({ tokenUsed, tokenMax, compactAt, workspace }: Props): React.ReactElement {
  const showBudget = tokenMax > 0;
  const fillPct = tokenMax > 0 ? Math.min(100, (tokenUsed / tokenMax) * 100) : 0;
  const budgetTitle =
    compactAt === undefined
      ? `${tokenUsed.toLocaleString()} / ${tokenMax.toLocaleString()} tokens used`
      : `${tokenUsed.toLocaleString()} / ${tokenMax.toLocaleString()} tokens in the last request. ` +
        `Auto-compact runs when the next request is forecast at ≥ ${Math.round(compactAt * tokenMax).toLocaleString()} ` +
        `(${Math.round(compactAt * 100)}%) — that forecast includes the newest reply and tool results, ` +
        'so it can fire while this bar reads lower.';

  return (
    <div id="forge-header">
      <div id="forge-brand" aria-label="Forge">
        {workspace?.forgeIconUri ? (
          <span
            id="forge-mark"
            aria-hidden="true"
            style={{
              maskImage: `url("${workspace.forgeIconUri}")`,
              WebkitMaskImage: `url("${workspace.forgeIconUri}")`,
            }}
          />
        ) : null}
        <span id="forge-wordmark">Forge</span>
      </div>
      <div
        id="workspace-root"
        className={workspace?.stale ? 'stale' : undefined}
        title={
          workspace
            ? [
                workspace.path || 'No folder is open - relative paths will not resolve.',
                workspace.extraRoots > 0
                  ? `+${workspace.extraRoots} more folder(s); tools only use this first one.`
                  : '',
                workspace.stale
                  ? 'The folder list changed since Forge started. Reload the window so tools follow it.'
                  : '',
              ]
                .filter(Boolean)
                .join('\n')
            : undefined
        }
      >
        <span id="workspace-root-name">
          {workspace?.name?.toLowerCase() === 'forge' ? '' : workspace?.name || 'no folder'}
        </span>
        {workspace && workspace.extraRoots > 0 && (
          <span id="workspace-root-extra">+{workspace.extraRoots}</span>
        )}
        {workspace?.stale && <span id="workspace-root-stale">reload needed</span>}
      </div>
      {showBudget && (
        <div id="token-budget" title={budgetTitle}>
          <div id="token-budget-bar-track">
            <div
              id="token-budget-bar-fill"
              style={{ width: `${fillPct}%`, background: budgetColor(tokenUsed, tokenMax) }}
            />
            {compactAt !== undefined && (
              <div id="token-budget-compact-at" style={{ left: `${compactAt * 100}%` }} />
            )}
          </div>
          <span id="token-budget-label">
            {formatTokens(tokenUsed)} / {formatTokens(tokenMax)}
          </span>
        </div>
      )}
    </div>
  );
}
