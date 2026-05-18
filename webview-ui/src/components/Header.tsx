import React from 'react';

interface Props {
  models: string[];
  activeModel: string | null;
  onModelChange: (name: string | null) => void;
  disabled: boolean;
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

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function Header({
  models,
  activeModel,
  onModelChange,
  disabled,
  streaming,
  tokenUsed,
  tokenMax,
}: Props): React.ReactElement {
  const showBudget = tokenUsed > 0;
  const fillPct = tokenMax > 0 ? Math.min(100, (tokenUsed / tokenMax) * 100) : 0;

  return (
    <div id="forge-header">
      <div id="forge-header-selects">
        <select
          id="model-select"
          value={activeModel ?? ''}
          disabled={disabled}
          onChange={(e) => onModelChange(e.target.value || null)}
          title={activeModel ?? 'No model selected'}
        >
          <option value="">No model selected</option>
          {models.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {streaming && (
          <span id="forge-typing" title="Generating…" aria-label="Generating">
            <span className="forge-typing-dot" />
            <span className="forge-typing-dot" />
            <span className="forge-typing-dot" />
          </span>
        )}
      </div>

      {showBudget && (
        <div id="token-budget" title={`${tokenUsed.toLocaleString()} / ${tokenMax.toLocaleString()} tokens used`}>
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
