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
 * The pinned-chip silhouette from `assets/icon.svg`, filled with the `forgeGlow`
 * gradient out of `assets/publisher-logo.svg`.
 *
 * Not the publisher logo itself: its chip body is `#111111` and disappears on a
 * dark sidebar, and the pixel-art "?" inside it is a 5x7 grid at 7px pitch that
 * turns to mush below ~24px. The full mark stays the Marketplace tile.
 */
const ForgeMark = (): React.ReactElement => (
  <svg id="forge-mark" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <defs>
      <linearGradient id="forge-mark-glow" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffd24a" />
        <stop offset="0.45" stopColor="#ff9a1f" />
        <stop offset="1" stopColor="#e8530e" />
      </linearGradient>
    </defs>
    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="url(#forge-mark-glow)" />
    <rect x="9" y="4" width="1.5" height="3" rx="0.5" fill="url(#forge-mark-glow)" />
    <rect x="13.5" y="4" width="1.5" height="3" rx="0.5" fill="url(#forge-mark-glow)" />
    <rect x="9" y="17" width="1.5" height="3" rx="0.5" fill="url(#forge-mark-glow)" />
    <rect x="13.5" y="17" width="1.5" height="3" rx="0.5" fill="url(#forge-mark-glow)" />
    <rect x="4" y="9" width="3" height="1.5" rx="0.5" fill="url(#forge-mark-glow)" />
    <rect x="4" y="13.5" width="3" height="1.5" rx="0.5" fill="url(#forge-mark-glow)" />
    <rect x="17" y="9" width="3" height="1.5" rx="0.5" fill="url(#forge-mark-glow)" />
    <rect x="17" y="13.5" width="3" height="1.5" rx="0.5" fill="url(#forge-mark-glow)" />
  </svg>
);

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
export function Header({ tokenUsed, tokenMax, workspace }: Props): React.ReactElement {
  const showBudget = tokenMax > 0;
  const fillPct = tokenMax > 0 ? Math.min(100, (tokenUsed / tokenMax) * 100) : 0;

  return (
    <div id="forge-header">
      <ForgeMark />
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
        <span id="workspace-root-name">{workspace?.name || 'no folder'}</span>
        {workspace && workspace.extraRoots > 0 && (
          <span id="workspace-root-extra">+{workspace.extraRoots}</span>
        )}
        {workspace?.stale && <span id="workspace-root-stale">reload needed</span>}
      </div>
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
