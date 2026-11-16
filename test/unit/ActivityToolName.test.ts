/**
 * The activity row names the tool that runs.
 *
 * `ModelTurn.ts` posts a `toolActivity` row (and an agent-progress event) before
 * the call is dispatched, and the renderer keys on the name. A name from another
 * agent's dialect is rewritten to Forge's tool — but only when nothing is
 * registered under it, which is the case an MCP server makes real when it exposes
 * its own `bash`, `ls` or `glob`. The row has to follow the same rule, or the
 * owner watches a row for `shell` while the server's `bash` is what ran.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { activityToolName } from '../../src/sidebar/toolSummary';

function registryWith(name: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    permission: 'read',
    handler: async () => 'ran',
  });
  return registry;
}

describe('the tool name the activity row shows', () => {
  it('keeps a registered tool whose name is also an alias', () => {
    // The MCP server's `bash` answers under its own name: preflight does not
    // rewrite a name the registry already has, so neither may the row.
    expect(activityToolName('bash', registryWith('bash'))).toBe('bash');
  });

  it('names the tool an unregistered alias resolves to', () => {
    // Nothing is registered under `ls`, so the call runs Forge's `list_directory`.
    expect(activityToolName('ls', registryWith('shell'))).toBe('list_directory');
  });

  it('leaves a name that is neither registered nor an alias as the model typed it', () => {
    expect(activityToolName('some_unknown_tool', new ToolRegistry())).toBe('some_unknown_tool');
  });
});
