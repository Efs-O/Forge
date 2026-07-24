import React, { useEffect, useState } from 'react';
import type { ModelManagerModelView } from '../../../../../src/sidebar/modelManager/messages';
import { FieldEditor } from './FieldEditor';

interface Props {
  model: ModelManagerModelView;
  onEdit: (field: string, value: unknown) => void;
  errorField: string | null;
}

function limitsToText(limits: Record<string, number> | undefined): string {
  return Object.entries(limits ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

function parseLimits(text: string): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const [name, value] = line.split(':').map((s) => s.trim());
    if (name && value !== undefined && value !== '') out[name] = Number(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Tool allowlist + per-tool call budget, resolved (group-inherited greyed,
 *  per-model overrides bold) per §2.3's Tools tab spec. */
export function ToolsTab({ model, onEdit, errorField }: Props): React.ReactElement {
  const toolsInherited = !model.overrideKeys.includes('tools');
  const limitsInherited = !model.overrideKeys.includes('tool_call_limits');
  const [limitsDraft, setLimitsDraft] = useState(() =>
    limitsToText(model.resolved.tool_call_limits),
  );

  useEffect(() => {
    setLimitsDraft(limitsToText(model.resolved.tool_call_limits));
  }, [model.name, model.resolved.tool_call_limits]);

  return (
    <div className="mm-tab-grid">
      <div className="mm-field mm-field--wide">
        <FieldEditor
          label="Tool allowlist (comma-separated)"
          field="tools"
          value={model.resolved.tools}
          inherited={toolsInherited}
          kind="list"
          onCommit={onEdit}
          errored={errorField === 'tools'}
          placeholder="read_file, list_directory, search_code, write_file"
        />
      </div>
      <div className={`mm-field mm-field--wide${limitsInherited ? ' mm-field--inherited' : ''}`}>
        <label htmlFor="mm-tool-limits">Tool call limits (one `tool: max` per line)</label>
        <textarea
          id="mm-tool-limits"
          value={limitsDraft}
          onChange={(e) => setLimitsDraft(e.target.value)}
          onBlur={() => onEdit('tool_call_limits', parseLimits(limitsDraft))}
        />
      </div>
    </div>
  );
}
