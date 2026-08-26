import React, { useState, useEffect, useRef } from 'react';
import type { ModelEntry } from '../../../src/sidebar/messageBridge';
import { groupModels } from '../modelGroups';

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

export function ModelSelector({
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
