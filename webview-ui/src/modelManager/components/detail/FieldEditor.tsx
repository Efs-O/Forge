import React, { useEffect, useState } from 'react';

export type FieldKind = 'text' | 'number' | 'boolean' | 'textarea' | 'stopList' | 'list';

interface Props {
  label: string;
  field: string; // dot-path, e.g. "sampling.temperature"
  value: unknown;
  /** True when this value came from a group/defaults, not an explicit
   *  override on this model — renders greyed per §2.3's detail-drawer spec. */
  inherited: boolean;
  kind?: FieldKind;
  onCommit: (field: string, value: unknown) => void;
  errored?: boolean;
  placeholder?: string;
}

function toEditString(value: unknown, kind: FieldKind): string {
  if (value === undefined || value === null) return '';
  if (kind === 'stopList' || kind === 'list')
    return Array.isArray(value) ? value.join(', ') : String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parseValue(raw: string, kind: FieldKind): unknown {
  const trimmed = raw.trim();
  if (kind === 'number') return trimmed === '' ? undefined : Number(trimmed);
  if (kind === 'list') {
    if (trimmed === '') return undefined;
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (kind === 'stopList') {
    if (trimmed === '') return undefined;
    const parts = trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length <= 1 ? (parts[0] ?? undefined) : parts;
  }
  return trimmed === '' ? undefined : trimmed;
}

/** Single editable field: commits on blur or Enter, greys inherited values,
 *  reddens on a validation error reported back from the host. Every commit
 *  round-trips through the panel's Zod-validated write path — this component
 *  never assumes success until the next `state` push confirms it. */
export function FieldEditor({
  label,
  field,
  value,
  inherited,
  kind = 'text',
  onCommit,
  errored,
  placeholder,
}: Props): React.ReactElement {
  const [draft, setDraft] = useState(() => toEditString(value, kind));

  useEffect(() => {
    setDraft(toEditString(value, kind));
  }, [value, kind]);

  const commit = (): void => onCommit(field, parseValue(draft, kind));

  if (kind === 'boolean') {
    return (
      <label className={`mm-field mm-field--bool${inherited ? ' mm-field--inherited' : ''}`}>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onCommit(field, e.target.checked)}
        />
        {label}
      </label>
    );
  }

  const className = `mm-field${inherited ? ' mm-field--inherited' : ''}${errored ? ' mm-field--error' : ''}`;

  return (
    <div className={className}>
      <label htmlFor={`mm-field-${field}`}>{label}</label>
      {kind === 'textarea' ? (
        <textarea
          id={`mm-field-${field}`}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          id={`mm-field-${field}`}
          type={kind === 'number' ? 'number' : 'text'}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      )}
    </div>
  );
}
