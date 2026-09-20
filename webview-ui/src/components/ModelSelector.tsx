import React, { useState, useEffect, useRef } from 'react';
import { splitModelProfile } from '../../../src/config/ConfigResolver';
import type { ModelEntry, ModelResidency } from '../../../src/sidebar/messageBridge';
import { groupModels } from '../modelGroups';

const RESIDENCY_TITLE: Record<ModelResidency, string> = {
  ready: 'Loaded and ready — this send starts immediately',
  loading: 'Loading — the backend is still starting up',
  cold: 'Not loaded — the next send loads this model first',
};

/**
 * Local backend state. Rendered only when the host sent a residency: remote
 * models hold no VRAM here, and a "cold" dot on one would imply a load cost
 * that does not exist.
 */
function ResidencyDot({ residency }: { residency?: ModelResidency }): React.ReactElement | null {
  if (!residency) return null;
  return (
    <span
      className={`ms-dot ms-dot--${residency}`}
      title={RESIDENCY_TITLE[residency]}
      aria-label={RESIDENCY_TITLE[residency]}
      role="img"
    />
  );
}

const ROLE_SUFFIXES = ['-coding', '-vision', '-worker'] as const;

function ProfileName({ profile }: { profile?: string }): React.ReactElement | null {
  return profile ? <span className="ms-profile">@{profile}</span> : null;
}

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
  const [profileModel, setProfileModel] = useState<ModelEntry | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setProfileModel(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setProfileModel(null);
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const groups = groupModels(models);
  const activeSelection = activeModel ? splitModelProfile(activeModel) : undefined;
  const activeModelEntry = activeSelection
    ? models.find((model) => model.name === activeSelection.base)
    : undefined;
  const close = () => {
    setOpen(false);
    setProfileModel(null);
  };

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
            <>
              <ResidencyDot residency={activeModelEntry?.residency} />
              <ModelName name={activeSelection?.base ?? activeModel} />
              <ProfileName profile={activeSelection?.profile} />
            </>
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
          {profileModel ? (
            <>
              <div className="ms-group-header" aria-hidden="true">
                {profileModel.name} — profile
              </div>
              <div
                className="ms-item"
                role="option"
                aria-selected={false}
                onClick={() => setProfileModel(null)}
              >
                ← All models
              </div>
              <div
                className={`ms-item${activeModel === profileModel.name ? ' ms-item--active' : ''}`}
                role="option"
                aria-selected={activeModel === profileModel.name}
                onClick={() => {
                  onModelChange(profileModel.name);
                  close();
                }}
              >
                <span className="ms-placeholder">No profile</span>
              </div>
              {(profileModel.profiles ?? []).map((profile) => {
                const selection = `${profileModel.name}@${profile}`;
                return (
                  <div
                    key={selection}
                    className={`ms-item${activeModel === selection ? ' ms-item--active' : ''}`}
                    role="option"
                    aria-selected={activeModel === selection}
                    onClick={() => {
                      onModelChange(selection);
                      close();
                    }}
                  >
                    @{profile}
                  </div>
                );
              })}
            </>
          ) : (
            <>
              <div
                className={`ms-item${!activeModel ? ' ms-item--active' : ''}`}
                role="option"
                aria-selected={!activeModel}
                onClick={() => {
                  onModelChange(null);
                  close();
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
                        if (m.profiles && m.profiles.length > 0) {
                          setProfileModel(m);
                          return;
                        }
                        onModelChange(m.name);
                        close();
                      }}
                    >
                      <ResidencyDot residency={m.residency} />
                      <ModelName name={m.name} />
                      {m.profiles && m.profiles.length > 0 && (
                        <span className="ms-profile-hint"> + profile</span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
