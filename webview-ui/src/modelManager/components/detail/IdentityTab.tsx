import React from 'react';
import type { ModelManagerModelView } from '../../../../../src/sidebar/modelManager/messages';
import { FieldEditor } from './FieldEditor';

interface Props {
  model: ModelManagerModelView;
  onEdit: (field: string, value: unknown) => void;
  errorField: string | null;
}

export function IdentityTab({ model, onEdit, errorField }: Props): React.ReactElement {
  const overridden = (k: string): boolean => model.overrideKeys.includes(k);
  return (
    <div className="mm-tab-grid">
      <div className="mm-field mm-field--readonly">
        <label>Name</label>
        <input value={model.name} readOnly />
      </div>
      <FieldEditor
        label="Short name"
        field="short_name"
        value={model.resolved.short_name}
        inherited={!overridden('short_name')}
        onCommit={onEdit}
        errored={errorField === 'short_name'}
        placeholder="e.g. gemma4"
      />
      <div className="mm-field mm-field--readonly">
        <label>Aliases</label>
        <input value={(model.raw.groups ?? []).join(', ') || '—'} readOnly />
      </div>
      <FieldEditor
        label="Provider"
        field="provider"
        value={model.resolved.provider}
        inherited={!overridden('provider')}
        onCommit={onEdit}
        errored={errorField === 'provider'}
      />
      <FieldEditor
        label="Group"
        field="group"
        value={model.raw.group}
        inherited={false}
        onCommit={onEdit}
        errored={errorField === 'group'}
        placeholder="board name"
      />
      <FieldEditor
        label="Category"
        field="category"
        value={model.resolved.category}
        inherited={!overridden('category')}
        onCommit={onEdit}
        errored={errorField === 'category'}
        placeholder="coding / vision / worker / experimental / cloud"
      />
      <div className="mm-field mm-field--wide">
        <FieldEditor
          label="Comment"
          field="comment"
          value={model.raw.comment}
          inherited={false}
          kind="textarea"
          onCommit={onEdit}
          errored={errorField === 'comment'}
          placeholder="Notes about this model — survives YAML rewrites."
        />
      </div>
    </div>
  );
}
