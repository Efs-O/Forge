import * as path from 'path';
import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import type { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { IndexManager } from '../../src/search/IndexManager';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { hasDelegationTools } from '../../src/sidebar/turnModelBehavior';
import { TemplateEngine } from '../../src/llm/TemplateEngine';
import { registerAllTools } from '../../src/tools/registerAllTools';
import { ALL_TOOL_PERMISSIONS, ToolRegistry } from '../../src/tools/ToolRegistry';
import type { ToolDefinition } from '../../src/llm/types';

/**
 * Lane 5 phase 5.3 (docs/plans/V1_FINISH_PLAN.md): the delegation rules reach a
 * turn only when that turn has someone to delegate to.
 *
 * The point is not the sentences, it is WHERE the yes/no comes from. It comes
 * from the tools' own `advertise` predicates — the registry filters them and
 * hands the result to `getToolDefinitions()`, and this reads that list the way
 * `webTools` already does. A template caller that re-read `agent_bus.enabled`
 * would be a second owner of that decision, and the prompt would then disagree
 * with the tool list the moment a predicate gained a case.
 */

const root = path.resolve(__dirname, '..', '..');
const engine = new TemplateEngine(path.join(root, 'config', 'templates', 'builtin'));

const def = (name: string): ToolDefinition => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
});

const ALL_PERMISSIONS = new Set(ALL_TOOL_PERMISSIONS);

function configWith(overrides: Partial<ForgeConfig>): ForgeConfig {
  return {
    active_model: 'm',
    llama_server: { binary: 'llama-server' },
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    ...overrides,
  } as ForgeConfig;
}

/** The real registration path, so the flag is measured against real predicates. */
function registryWith(config: ForgeConfig): ToolRegistry {
  const registry = new ToolRegistry();
  const workspaceState = { get: () => undefined, update: async () => undefined };
  const secrets = { get: async () => undefined };
  const indexManager = { search: async () => [] };
  const delegation = {
    ask: async () => ({ text: 'ok', targetModel: 'm', bestEffort: false }),
  } as unknown as LocalDelegationService;
  registerAllTools(
    registry,
    workspaceState as unknown as vscode.Memento,
    secrets as unknown as vscode.SecretStorage,
    undefined,
    indexManager as unknown as IndexManager,
    new UserQuestionService(),
    new UserNotificationService(),
    delegation,
    () => config,
  );
  return registry;
}

const advertised = (config: ForgeConfig): string[] =>
  registryWith(config)
    .definitions(ALL_PERMISSIONS)
    .map((definition) => definition.function.name);

describe('hasDelegationTools', () => {
  it('is true for either delegation tool and false for neither', () => {
    expect(hasDelegationTools([def('edit_file'), def('web_search')])).toBe(false);
    expect(hasDelegationTools([])).toBe(false);
    expect(hasDelegationTools([def('ask_agent')])).toBe(true);
    expect(hasDelegationTools([def('ask_local_agent')])).toBe(true);
    expect(hasDelegationTools([def('list_delegation_targets')])).toBe(false);
  });

  it('follows the advertise predicates of the real registry', () => {
    // Nothing configured: no agent bus and no model anyone could delegate to.
    const nothing = advertised(configWith({ models: [] }));
    expect(nothing).not.toContain('ask_agent');
    expect(nothing).not.toContain('ask_local_agent');
    expect(hasDelegationTools(nothing.map(def))).toBe(false);
    // A configured local model is a target, so ask_local_agent is advertised and
    // the block comes with it even though the agent bus stays off. The
    // permission tier is not what this measures: `definitions` is called with
    // every permission, so only the tools' own `advertise` predicates can hide
    // a tool, which is the point of reading the flag from this list.
    const localOnly = advertised(configWith({}));
    expect(localOnly).toContain('ask_local_agent');
    expect(localOnly).not.toContain('ask_agent');
    expect(hasDelegationTools(localOnly.map(def))).toBe(true);
    // The agent bus on with nothing local: ask_agent alone is enough.
    const busOnly = advertised(configWith({ agent_bus: { enabled: true }, models: [] }));
    expect(busOnly).toContain('ask_agent');
    expect(busOnly).not.toContain('ask_local_agent');
    expect(hasDelegationTools(busOnly.map(def))).toBe(true);
    const mesh = advertised(configWith({ agent_bus: { enabled: true } }));
    expect(mesh).toContain('ask_agent');
    expect(mesh).toContain('ask_local_agent');
    expect(hasDelegationTools(mesh.map(def))).toBe(true);
  });
});

describe('the delegation block in the system prompt', () => {
  it('is absent from a turn with no delegation tools, and the rules close without a stray line', () => {
    const rendered = engine.render('execute', { workspaceRoot: 'N:/work' });
    expect(rendered).not.toContain('Delegate for thinking');
    expect(rendered).not.toContain('Never claim a delegate ran');
    expect(rendered).not.toContain('ask_local_agent');
    // The off case must be byte-identical to what this template printed before
    // the block existed: no blank line left where the conditional was.
    expect(rendered).toContain('a preview result is a tool result.\n</rules>');
  });

  it('says who to delegate to, and how, when either tool is offered', () => {
    const rendered = engine.render('execute', { agentTools: 'true' });
    expect(rendered).toContain('You implement by default');
    expect(rendered).toContain('Delegate for thinking, not for typing');
    expect(rendered).toContain('Claude Code, Codex');
    expect(rendered).toContain('one completion with no tool channel');
    expect(rendered).toContain('`ask_agent` asks the session already linked to this chat');
    expect(rendered).toContain('goes to a NEW session');
    expect(rendered).toContain('shared board is not a notification');
    expect(rendered).toContain('Never claim a delegate ran unless the tool returned its result');
    // What is only true of THIS workspace stays out: Forge Relay, and the rule
    // about the mesh-run Codex reviewer, belong in this repo's FORGE.md.
    expect(rendered).not.toContain('Forge Relay');
    expect(rendered).not.toContain('COORDINATION.md');
    expect(rendered).toContain('a preview result is a tool result.\n- You implement by default');
  });

  it('is a bounded addition to the prompt when it is on', () => {
    const off = engine.render('execute', { workspaceRoot: 'N:/work' });
    const on = engine.render('execute', { workspaceRoot: 'N:/work', agentTools: 'true' });
    const added = Buffer.byteLength(on, 'utf8') - Buffer.byteLength(off, 'utf8');
    // Measured 2026-10-27: the seven bullets add 1,011 bytes (about 219 tokens
    // at the ~4.62 chars/token ratio the tool-schema gate uses), and they are
    // paid only by a turn that has someone to delegate to. 1,100 bytes is the
    // ceiling: an eighth bullet, or one long example, would trip it and force
    // the decision now rather than after the prompt has grown.
    expect(added).toBeGreaterThan(400);
    expect(added).toBeLessThan(1100);
  });

  it('leaves the web-tools line as it was', () => {
    expect(engine.render('execute', {})).not.toContain('Facts that change between releases');
    expect(engine.render('execute', { webTools: 'true' })).toContain(
      'Facts that change between releases',
    );
    const both = engine.render('execute', { webTools: 'true', agentTools: 'true' });
    expect(both).toContain('Facts that change between releases');
    expect(both).toContain('Delegate for thinking');
  });
});
