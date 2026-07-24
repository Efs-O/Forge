import React from 'react';
import type { ModelManagerModelView } from '../../../../src/sidebar/modelManager/messages';
import { formatBytes, formatRelativeTime } from '../formatters';

interface Props {
  models: ModelManagerModelView[];
  selected: string[];
  focused: string | null;
  onFocus: (name: string) => void;
  onToggleSelect: (name: string) => void;
  onOpenDrawer: (name: string) => void;
  onLoadAndTry: (name: string) => void;
  loadingNames: string[];
}

/** Left master list — name/provider/size/last-used/group/category, loaded &
 *  active dots, dead-entry warning icon. Keyboard nav is driven by the
 *  parent (App.tsx) via a document-level listener; this component only
 *  renders and wires click/checkbox handlers. */
export function ModelList({
  models,
  selected,
  focused,
  onFocus,
  onToggleSelect,
  onOpenDrawer,
  onLoadAndTry,
  loadingNames,
}: Props): React.ReactElement {
  return (
    <ul className="mm-list" role="listbox" aria-label="Configured models">
      {models.map((m) => {
        const isSelected = selected.includes(m.name);
        const isFocused = focused === m.name;
        return (
          <li
            key={m.name}
            role="option"
            aria-selected={isSelected}
            className={`mm-row${isFocused ? ' mm-row--focused' : ''}${isSelected ? ' mm-row--selected' : ''}`}
            onClick={() => onFocus(m.name)}
            onDoubleClick={() => onOpenDrawer(m.name)}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => onToggleSelect(m.name)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${m.name}`}
            />
            <span
              className={`mm-dot mm-dot--${m.isLoaded ? 'loaded' : m.isActive ? 'active' : 'idle'}`}
            />
            <span className="mm-name" title={m.name}>
              {m.fileMissing ? (
                <span className="mm-warn" title="File missing on disk">
                  ⚠
                </span>
              ) : null}
              {m.name}
            </span>
            <span className="mm-badge">{m.provider}</span>
            <span className="mm-size">{formatBytes(m.sizeBytes)}</span>
            <span className="mm-used">{formatRelativeTime(m.lastUsed)}</span>
            <span className="mm-group">{m.raw.group ?? m.raw.groups?.join(',') ?? ''}</span>
            <span className="mm-category">{m.raw.category ?? ''}</span>
            <button
              className="mm-try-btn"
              disabled={loadingNames.includes(m.name)}
              onClick={(e) => {
                e.stopPropagation();
                onLoadAndTry(m.name);
              }}
            >
              {loadingNames.includes(m.name) ? '…' : 'Load & try'}
            </button>
          </li>
        );
      })}
      {models.length === 0 ? (
        <li className="mm-empty">No models match the current filter.</li>
      ) : null}
    </ul>
  );
}
