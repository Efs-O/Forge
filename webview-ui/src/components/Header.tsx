import React, { useState, useEffect, useRef } from 'react';
import type { ModelEntry } from '../../../src/sidebar/messageBridge';
import { groupModels } from '../modelGroups';

interface Props {
  models: ModelEntry[];
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

const ROLE_SUFFIXES = ['-coding', '-vision', '-worker'] as const;

function ModelName({ name }: { name: string }): React.ReactElement {
  for (const suffix of ROLE_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return (
        <>
          {name.slice(0, -suffix.length)}
          <span className="ms-role">{suffix}</span>
        </>
      );
    }
  }
  return <>{name}</>;
}

interface SelectorProps {
  models: ModelEntry[];
  activeModel: string | null;
  onModelChange: (name: string | null) => void;
  disabled: boolean;
}

function ModelSelector({
  models,
  activeModel,
  onModelChange,
  disabled,
}: SelectorProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const groups = groupModels(models);

  return (
    <div className="ms-root" ref={rootRef}>
      <button
        className="ms-trigger"
        onClick={() => {
          if (!disabled) setOpen((o) => !o);
        }}
        disabled={disabled}
        title={activeModel ?? 'No model selected'}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="ms-trigger-name">
          {activeModel ? (
            <ModelName name={activeModel} />
          ) : (
            <span className="ms-placeholder">No model selected</span>
          )}
        </span>
        <span className="ms-chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="ms-panel" role="listbox" aria-label="Select model">
          <div
            className={`ms-item${!activeModel ? ' ms-item--active' : ''}`}
            role="option"
            aria-selected={!activeModel}
            onClick={() => {
              onModelChange(null);
              setOpen(false);
            }}
          >
            <span className="ms-placeholder">No model selected</span>
          </div>

          {groups.map(({ label, entries }) => (
            <div key={label} className="ms-group">
              <div className="ms-group-header" aria-hidden="true">
                {label}
              </div>
              {entries.map((m) => (
                <div
                  key={m.name}
                  className={`ms-item${m.name === activeModel ? ' ms-item--active' : ''}`}
                  role="option"
                  aria-selected={m.name === activeModel}
                  onClick={() => {
                    onModelChange(m.name);
                    setOpen(false);
                  }}
                >
                  <ModelName name={m.name} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
  const showBudget = tokenMax > 0;
  const fillPct = tokenMax > 0 ? Math.min(100, (tokenUsed / tokenMax) * 100) : 0;

  return (
    <div id="forge-header">
      <div id="forge-header-selects">
        <ModelSelector
          models={models}
          activeModel={activeModel}
          onModelChange={onModelChange}
          disabled={disabled}
        />
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
