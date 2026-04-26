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
}

export function Header({ models, activeModel, mode, onModelChange, onModeChange, onNewChat, disabled }: Props): React.ReactElement {
  return (
    <div id="forge-header">
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
  );
}
