import React from 'react';
import { formatTokens } from '../../../src/util/formatTokens';

interface Props {
  tokenUsed: number;
  tokenMax: number;
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
export function Header({ tokenUsed, tokenMax }: Props): React.ReactElement {
  const showBudget = tokenMax > 0;
  const fillPct = tokenMax > 0 ? Math.min(100, (tokenUsed / tokenMax) * 100) : 0;

  return (
    <div id="forge-header">
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
