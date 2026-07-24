import React from 'react';
import type { ModelManagerModelView } from '../../../../../src/sidebar/modelManager/messages';
import { FieldEditor } from './FieldEditor';

interface Props {
  model: ModelManagerModelView;
  onEdit: (field: string, value: unknown) => void;
  errorField: string | null;
}

/** llama.cpp `spawn:` block + extra args. Edits go through the whole
 *  `spawn` object (dot-path field="spawn.<key>") — editOps rewrites the
 *  top-level `spawn:` map in one commit so untouched sibling keys survive. */
export function RuntimeTab({ model, onEdit, errorField }: Props): React.ReactElement {
  const spawn = model.resolved.spawn ?? {};
  const inherited = !model.overrideKeys.includes('spawn');
  return (
    <div className="mm-tab-grid">
      <FieldEditor
        label="num_ctx"
        field="spawn.num_ctx"
        value={spawn.num_ctx}
        inherited={inherited}
        kind="number"
        onCommit={onEdit}
        errored={errorField === 'spawn.num_ctx'}
      />
      <FieldEditor
        label="n_batch"
        field="spawn.n_batch"
        value={spawn.n_batch}
        inherited={inherited}
        kind="number"
        onCommit={onEdit}
        errored={errorField === 'spawn.n_batch'}
      />
      <FieldEditor
        label="n_parallel"
        field="spawn.n_parallel"
        value={spawn.n_parallel}
        inherited={inherited}
        kind="number"
        onCommit={onEdit}
        errored={errorField === 'spawn.n_parallel'}
      />
      <FieldEditor
        label="n_gpu_layers"
        field="spawn.n_gpu_layers"
        value={spawn.n_gpu_layers}
        inherited={inherited}
        kind="number"
        onCommit={onEdit}
        errored={errorField === 'spawn.n_gpu_layers'}
      />
      <FieldEditor
        label="type_k"
        field="spawn.type_k"
        value={spawn.type_k}
        inherited={inherited}
        onCommit={onEdit}
        errored={errorField === 'spawn.type_k'}
      />
      <FieldEditor
        label="type_v"
        field="spawn.type_v"
        value={spawn.type_v}
        inherited={inherited}
        onCommit={onEdit}
        errored={errorField === 'spawn.type_v'}
      />
      <FieldEditor
        label="flash_attn"
        field="spawn.flash_attn"
        value={spawn.flash_attn}
        inherited={inherited}
        kind="boolean"
        onCommit={onEdit}
        errored={errorField === 'spawn.flash_attn'}
      />
      <div className="mm-field mm-field--wide">
        <FieldEditor
          label="Extra llama-server args (comma-separated)"
          field="spawn.extra_llama_server_args"
          value={spawn.extra_llama_server_args}
          inherited={inherited}
          kind="list"
          onCommit={onEdit}
          errored={errorField === 'spawn.extra_llama_server_args'}
        />
      </div>
    </div>
  );
}
