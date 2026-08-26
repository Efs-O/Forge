import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';

function taskSummary(task: vscode.Task): Record<string, string | undefined> {
  return {
    name: task.name,
    source: task.source,
    definition_type: typeof task.definition.type === 'string' ? task.definition.type : undefined,
    group: task.group?.id,
  };
}

export function makeListWorkspaceTasksTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'list_workspace_tasks',
        description: 'List VS Code workspace tasks available to run by exact name.',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    },
    permission: 'read',
    handler: async () =>
      JSON.stringify({ tasks: (await vscode.tasks.fetchTasks()).map(taskSummary) }),
  };
}

export function makeRunWorkspaceTaskTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'run_workspace_task',
        description:
          'Run a configured VS Code workspace task by exact name. Use list_workspace_tasks first.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', minLength: 1, description: 'Exact task name.' } },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    handler: async (args) => {
      const name = args['name'] as string;
      const matches = (await vscode.tasks.fetchTasks()).filter((task) => task.name === name);
      if (matches.length === 0) throw new Error(`run_workspace_task: no task named "${name}".`);
      if (matches.length > 1) {
        throw new Error(
          `run_workspace_task: ${matches.length} tasks are named "${name}"; use a unique task name.`,
        );
      }
      const execution = await vscode.tasks.executeTask(matches[0]);
      return `Started workspace task "${name}" (execution ${execution.task.name}).`;
    },
  };
}
