import { describe, expect, it } from 'vitest';
import { ToolBudget } from '../../src/tools/ToolBudget';
import type { ToolDefinition } from '../../src/llm/types';

function def(name: string): ToolDefinition {
  return {
    type: 'function',
    function: { name, description: 'test', parameters: { type: 'object' } },
  };
}

describe('ToolBudget', () => {
  it('does not filter or block anything when tools/tool_call_limits are absent', () => {
    const budget = new ToolBudget({});
    const defs = [def('read_file'), def('run_terminal')];
    expect(budget.filterDefinitions(defs)).toEqual(defs);
    expect(budget.check('read_file')).toBeNull();
    expect(budget.check('run_terminal')).toBeNull();
  });

  it('does not filter or block anything when tools is an empty array', () => {
    const budget = new ToolBudget({ tools: [] });
    const defs = [def('read_file')];
    expect(budget.filterDefinitions(defs)).toEqual(defs);
    expect(budget.check('read_file')).toBeNull();
  });

  it('filters advertised definitions down to the allowlist', () => {
    const budget = new ToolBudget({ tools: ['read_file'] });
    const defs = [def('read_file'), def('run_terminal')];
    expect(budget.filterDefinitions(defs).map((d) => d.function.name)).toEqual(['read_file']);
  });

  it('blocks dispatch of a non-allowlisted tool with a structured message', () => {
    const budget = new ToolBudget({ tools: ['read_file'] });
    expect(budget.check('run_terminal')).toBe('Tool run_terminal is not available for this model.');
    expect(budget.check('read_file')).toBeNull();
  });

  it('excludes a limit-0 tool from advertisement entirely', () => {
    const budget = new ToolBudget({ tool_call_limits: { run_terminal: 0 } });
    const defs = [def('read_file'), def('run_terminal')];
    expect(budget.filterDefinitions(defs).map((d) => d.function.name)).toEqual(['read_file']);
  });

  it('blocks a limit-0 tool at dispatch time too, defense in depth', () => {
    const budget = new ToolBudget({ tool_call_limits: { run_terminal: 0 } });
    expect(budget.check('run_terminal')).toMatch(/^Budget exhausted:/);
  });

  it('allows calls under the limit and blocks once exhausted, counting per tool name', () => {
    const budget = new ToolBudget({ tool_call_limits: { run_terminal: 2 } });
    expect(budget.check('run_terminal')).toBeNull();
    expect(budget.check('run_terminal')).toBeNull();
    expect(budget.check('run_terminal')).toBe(
      'Budget exhausted: run_terminal was limited to 2 calls this turn (2 used). ' +
        'Do not call it again; wrap up with what you have.',
    );
  });

  it('tracks separate budgets per tool name', () => {
    const budget = new ToolBudget({ tool_call_limits: { run_terminal: 1, web_search: 1 } });
    expect(budget.check('run_terminal')).toBeNull();
    expect(budget.check('web_search')).toBeNull();
    expect(budget.check('run_terminal')).toMatch(/^Budget exhausted:/);
    expect(budget.check('web_search')).toMatch(/^Budget exhausted:/);
  });

  it('does not limit tools absent from tool_call_limits', () => {
    const budget = new ToolBudget({ tool_call_limits: { run_terminal: 1 } });
    for (let i = 0; i < 5; i++) {
      expect(budget.check('read_file')).toBeNull();
    }
  });

  it('resets counters between instances (per-turn semantics)', () => {
    const model = { tool_call_limits: { run_terminal: 1 } };
    const first = new ToolBudget(model);
    expect(first.check('run_terminal')).toBeNull();
    expect(first.check('run_terminal')).toMatch(/^Budget exhausted:/);

    const second = new ToolBudget(model);
    expect(second.check('run_terminal')).toBeNull();
  });
});
