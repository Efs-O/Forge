import React, { useState } from 'react';
import type { GroupConfig } from '../../../../src/config/types';

interface Props {
  groups: Record<string, GroupConfig>;
  onSetField: (groupName: string, field: string, value: unknown) => void;
  onAddGroup: (groupName: string) => void;
  onRemoveGroup: (groupName: string) => void;
  onClose: () => void;
}

/** Toolbar's "Groups editor" — edit the shared boards themselves (§2.3). Kept
 *  intentionally minimal: the common fields models actually share (spawn
 *  num_ctx, sampling top_k/stop, provider/endpoint) plus a JSON escape hatch
 *  for anything else. */
export function GroupsEditor({
  groups,
  onSetField,
  onAddGroup,
  onRemoveGroup,
  onClose,
}: Props): React.ReactElement {
  const [newName, setNewName] = useState('');
  const names = Object.keys(groups).sort();

  return (
    <div className="mm-modal-backdrop" onClick={onClose}>
      <div
        className="mm-modal mm-modal--wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h3>Groups ("boards")</h3>
        <div className="mm-modal-actions">
          <input
            placeholder="new group name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            disabled={!newName.trim()}
            onClick={() => {
              onAddGroup(newName.trim());
              setNewName('');
            }}
          >
            Add group
          </button>
          <button onClick={onClose}>Close</button>
        </div>
        <ul className="mm-groups-list">
          {names.map((name) => {
            const g = groups[name];
            return (
              <li key={name} className="mm-group-row">
                <div className="mm-group-row-header">
                  <strong>{name}</strong>
                  <button className="mm-danger-btn" onClick={() => onRemoveGroup(name)}>
                    Remove
                  </button>
                </div>
                <div className="mm-tab-grid">
                  <label className="mm-field">
                    <span>provider</span>
                    <input
                      defaultValue={g.provider ?? ''}
                      onBlur={(e) => onSetField(name, 'provider', e.target.value || undefined)}
                    />
                  </label>
                  <label className="mm-field">
                    <span>endpoint</span>
                    <input
                      defaultValue={g.endpoint ?? ''}
                      onBlur={(e) => onSetField(name, 'endpoint', e.target.value || undefined)}
                    />
                  </label>
                  <label className="mm-field">
                    <span>num_ctx</span>
                    <input
                      type="number"
                      defaultValue={g.num_ctx ?? ''}
                      onBlur={(e) =>
                        onSetField(
                          name,
                          'num_ctx',
                          e.target.value ? Number(e.target.value) : undefined,
                        )
                      }
                    />
                  </label>
                  <label className="mm-field">
                    <span>tools (comma-separated)</span>
                    <input
                      defaultValue={(g.tools ?? []).join(', ')}
                      onBlur={(e) =>
                        onSetField(
                          name,
                          'tools',
                          e.target.value
                            ? e.target.value
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean)
                            : undefined,
                        )
                      }
                    />
                  </label>
                </div>
              </li>
            );
          })}
          {names.length === 0 ? <li className="mm-empty">No groups defined yet.</li> : null}
        </ul>
      </div>
    </div>
  );
}
