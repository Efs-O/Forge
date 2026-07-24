import React from 'react';
import type { ModelManagerModelView } from '../../../../../src/sidebar/modelManager/messages';
import { FieldEditor } from './FieldEditor';
import { formatBytes } from '../../formatters';

interface Props {
  model: ModelManagerModelView;
  onEdit: (field: string, value: unknown) => void;
  errorField: string | null;
  onReveal: () => void;
}

export function LocationTab({ model, onEdit, errorField, onReveal }: Props): React.ReactElement {
  const overridden = (k: string): boolean => model.overrideKeys.includes(k);
  return (
    <div className="mm-tab-grid">
      <FieldEditor
        label="GGUF path"
        field="gguf_path"
        value={model.raw.gguf_path}
        inherited={false}
        onCommit={onEdit}
        errored={errorField === 'gguf_path'}
      />
      <FieldEditor
        label="mmproj path"
        field="mmproj_path"
        value={model.raw.mmproj_path}
        inherited={false}
        onCommit={onEdit}
        errored={errorField === 'mmproj_path'}
      />
      <FieldEditor
        label="Endpoint"
        field="endpoint"
        value={model.resolved.endpoint}
        inherited={!overridden('endpoint')}
        onCommit={onEdit}
        errored={errorField === 'endpoint'}
      />
      <FieldEditor
        label="API key secret name"
        field="api_key_secret"
        value={model.raw.api_key_secret}
        inherited={false}
        onCommit={onEdit}
        errored={errorField === 'api_key_secret'}
      />
      <div className="mm-field mm-field--readonly">
        <label>Size on disk</label>
        <input value={formatBytes(model.sizeBytes)} readOnly />
      </div>
      <div className="mm-field mm-field--readonly">
        <label>Quant / family</label>
        <input value={[model.quant, model.family].filter(Boolean).join(' · ') || '—'} readOnly />
      </div>
      {model.raw.gguf_path ? (
        <button className="mm-reveal-btn" onClick={onReveal}>
          Reveal in Explorer
        </button>
      ) : null}
    </div>
  );
}
