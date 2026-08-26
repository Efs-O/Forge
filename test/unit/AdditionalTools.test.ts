import { describe, expect, it } from 'vitest';
import { makeApplyCodeActionTool, makeGetCodeActionsTool } from '../../src/tools/codeActionTools';
import { makeEditNotebookCellTool, makeReadNotebookTool } from '../../src/tools/notebookTools';
import {
  makeListWorkspaceTasksTool,
  makeRunWorkspaceTaskTool,
} from '../../src/tools/taskTools';

describe('additional VS Code-native tools', () => {
  it('uses strict schemas and the appropriate capability gates', () => {
    const tools = [
      makeGetCodeActionsTool(),
      makeApplyCodeActionTool(),
      makeReadNotebookTool(),
      makeEditNotebookCellTool(),
      makeListWorkspaceTasksTool(),
      makeRunWorkspaceTaskTool(),
    ];
    expect(tools.map((tool) => tool.definition.function.name)).toEqual([
      'get_code_actions',
      'apply_code_action',
      'read_notebook',
      'edit_notebook_cell',
      'list_workspace_tasks',
      'run_workspace_task',
    ]);
    expect(tools.map((tool) => tool.definition.function.parameters.additionalProperties)).toEqual([
      false,
      false,
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
      'read',
      'headless',
    ]);
    expect(tools.filter((tool) => tool.permission === 'write').every((tool) => tool.mutation)).toBe(
      true,
    );
  });
});
