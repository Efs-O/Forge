import React from 'react';
import type { Mode } from '../../../src/llm/types';

interface Props {
  models: string[];
  activeModel: string;
  mode: Mode;
  onModelChange: (name: string) => void;
  onModeChange: (mode: Mode) => void;
  onNewChat: () => void;
  disabled: boolean;
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

export function Header({
  models,
  activeModel,
  mode,
  onModelChange,
  onModeChange,
  onNewChat,
  disabled,
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
          value={activeModel}
          disabled={disabled}
          onChange={(e) => onModelChange(e.target.value)}
        >
          {models.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <select
          id="mode-select"
          value={mode}
          disabled={disabled}
          onChange={(e) => onModeChange(e.target.value as Mode)}
        >
          <option value="ask">Ask</option>
          <option value="plan">Plan</option>
          <option value="execute">Execute</option>
        </select>
        <button
          id="new-chat-btn"
          title="New Chat"
          disabled={disabled}
          onClick={onNewChat}
        >+</button>
      </div>

      {showBudget && (
        <div id="token-budget">
          <div id="token-budget-bar-track">
            <div
              id="token-budget-bar-fill"
              style={{ width: `${fillPct}%`, background: budgetColor(tokenUsed, tokenMax) }}
            />
          </div>
          <span id="token-budget-label">{tokenUsed}/{tokenMax} tok</span>
        </div>
      )}
    </div>
  );
}
