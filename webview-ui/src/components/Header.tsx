import React from 'react';
import { formatTokens } from '../../../src/util/formatTokens';

interface Props {
  streaming: boolean;
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
 * Ambient conversation status: how full the context is, and whether a turn is
 * running. The model selector deliberately does NOT live here — it moved next
 * to the prompt, where the choice is actually made. The budget stayed behind
 * because it has to stay readable while scrolling the transcript, not only when
 * you look down to type.
 */
export function Header({ streaming, tokenUsed, tokenMax }: Props): React.ReactElement {
  const showBudget = tokenMax > 0;
  const fillPct = tokenMax > 0 ? Math.min(100, (tokenUsed / tokenMax) * 100) : 0;

  return (
    <div id="forge-header">
      <div id="forge-header-selects">
        {streaming && (
          <span id="forge-typing" title="Generating…" aria-label="Generating">
            <span className="forge-typing-dot" />
            <span className="forge-typing-dot" />
            <span className="forge-typing-dot" />
          </span>
        )}
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
