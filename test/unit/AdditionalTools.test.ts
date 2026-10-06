import { describe, expect, it } from 'vitest';
import { makeApplyCodeActionTool } from '../../src/tools/codeActionTools';
import { makeCodeIntelTool } from '../../src/tools/codeIntelTool';
import { makeEditNotebookCellTool, makeReadNotebookTool } from '../../src/tools/notebookTools';

describe('additional VS Code-native tools', () => {
  it('uses strict schemas and the appropriate capability gates', () => {
    const tools = [
      makeCodeIntelTool(),
      makeApplyCodeActionTool(),
      makeReadNotebookTool(),
      makeEditNotebookCellTool(),
    ];
    expect(tools.map((tool) => tool.definition.function.name)).toEqual([
      'code_intel',
      'apply_code_action',
      'read_notebook',
      'edit_notebook_cell',
    ]);
    expect(tools.map((tool) => tool.definition.function.parameters.additionalProperties)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(tools.map((tool) => tool.permission)).toEqual([
      'read',
      'write',
      'read',
      'write',
    ]);
    expect(tools.filter((tool) => tool.permission === 'write').every((tool) => tool.mutation)).toBe(
      true,
    );
  });
});
