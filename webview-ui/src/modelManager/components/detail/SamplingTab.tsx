import React from 'react';
import type { ModelManagerModelView } from '../../../../../src/sidebar/modelManager/messages';
import { FieldEditor } from './FieldEditor';

interface Props {
  model: ModelManagerModelView;
  onEdit: (field: string, value: unknown) => void;
  errorField: string | null;
}

export function SamplingTab({ model, onEdit, errorField }: Props): React.ReactElement {
  const sampling = model.resolved.sampling ?? {};
  const inherited = !model.overrideKeys.includes('sampling');
  const num = (field: string, value: number | undefined): React.ReactElement => (
    <FieldEditor
      label={field}
      field={`sampling.${field}`}
      value={value}
      inherited={inherited}
      kind="number"
      onCommit={onEdit}
      errored={errorField === `sampling.${field}`}
    />
  );
  return (
    <div className="mm-tab-grid">
      {num('temperature', sampling.temperature)}
      {num('top_p', sampling.top_p)}
      {num('top_k', sampling.top_k)}
      {num('min_p', sampling.min_p)}
      {num('max_tokens', sampling.max_tokens)}
      {num('seed', sampling.seed)}
      {num('presence_penalty', sampling.presence_penalty)}
      {num('frequency_penalty', sampling.frequency_penalty)}
      {num('repetition_penalty', sampling.repetition_penalty)}
      {num('repeat_penalty', sampling.repeat_penalty)}
      {num('repeat_last_n', sampling.repeat_last_n)}
      <FieldEditor
        label="stop (comma-separated)"
        field="sampling.stop"
        value={sampling.stop}
        inherited={inherited}
        kind="stopList"
        onCommit={onEdit}
        errored={errorField === 'sampling.stop'}
      />
      <FieldEditor
        label="preserve_thinking"
        field="sampling.preserve_thinking"
        value={sampling.preserve_thinking}
        inherited={inherited}
        kind="boolean"
        onCommit={onEdit}
        errored={errorField === 'sampling.preserve_thinking'}
      />
    </div>
  );
}
