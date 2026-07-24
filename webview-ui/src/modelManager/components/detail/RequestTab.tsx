import React from 'react';
import type { ModelManagerModelView } from '../../../../../src/sidebar/modelManager/messages';
import { FieldEditor } from './FieldEditor';

interface Props {
  model: ModelManagerModelView;
  onEdit: (field: string, value: unknown) => void;
  errorField: string | null;
}

export function RequestTab({ model, onEdit, errorField }: Props): React.ReactElement {
  const overridden = (k: string): boolean => model.overrideKeys.includes(k);
  return (
    <div className="mm-tab-grid">
      <FieldEditor
        label="num_ctx"
        field="num_ctx"
        value={model.resolved.num_ctx}
        inherited={!overridden('num_ctx')}
        kind="number"
        onCommit={onEdit}
        errored={errorField === 'num_ctx'}
      />
      <FieldEditor
        label="think"
        field="think"
        value={model.resolved.think}
        inherited={!overridden('think')}
        kind="boolean"
        onCommit={onEdit}
        errored={errorField === 'think'}
      />
      <FieldEditor
        label="reasoning_effort"
        field="reasoning_effort"
        value={model.resolved.reasoning_effort}
        inherited={!overridden('reasoning_effort')}
        onCommit={onEdit}
        errored={errorField === 'reasoning_effort'}
        placeholder="high / medium / low / none"
      />
      <FieldEditor
        label="strip_tools"
        field="strip_tools"
        value={model.resolved.strip_tools}
        inherited={!overridden('strip_tools')}
        kind="boolean"
        onCommit={onEdit}
        errored={errorField === 'strip_tools'}
      />
      <FieldEditor
        label="strip_thinking_channels"
        field="strip_thinking_channels"
        value={model.resolved.strip_thinking_channels}
        inherited={!overridden('strip_thinking_channels')}
        kind="boolean"
        onCommit={onEdit}
        errored={errorField === 'strip_thinking_channels'}
      />
      <FieldEditor
        label="system_prompt_mode"
        field="system_prompt_mode"
        value={model.resolved.system_prompt_mode}
        inherited={!overridden('system_prompt_mode')}
        onCommit={onEdit}
        errored={errorField === 'system_prompt_mode'}
        placeholder="append / replace"
      />
      <FieldEditor
        label="capabilities (comma-separated)"
        field="capabilities"
        value={model.resolved.capabilities}
        inherited={!overridden('capabilities')}
        kind="list"
        onCommit={onEdit}
        errored={errorField === 'capabilities'}
        placeholder="tool-call, vision, long-context"
      />
      <div className="mm-field mm-field--wide">
        <FieldEditor
          label="system_prompt"
          field="system_prompt"
          value={model.raw.system_prompt}
          inherited={false}
          kind="textarea"
          onCommit={onEdit}
          errored={errorField === 'system_prompt'}
        />
      </div>
    </div>
  );
}
