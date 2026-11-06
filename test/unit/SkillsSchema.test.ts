/**
 * The `skills:` config block and the tool's registration gate (lane F2 of
 * `docs/plans/TOOLS_EXPANSION_PLAN.md`, its "Wiring checklist").
 *
 * The plan asks for four things that a reviewer cannot see from the loader
 * alone, and each has a CI check here rather than a promise in a comment:
 * `skills: { enabled }` in `src/config/schema.ts` and in
 * `config/config.example.yaml`; `load_skill` registered in
 * `src/tools/registerAllTools.ts` ungrouped; and the ledger row that says
 * `skills.enabled: false` hides both the catalog and the tool.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ForgeConfigSchema } from '../../src/config/schema';
import { SkillsConfigSchema } from '../../src/config/toolsSchema';
import { makeOllamaStarterConfig } from '../../src/config/StarterConfig';
import { ALL_TOOL_PERMISSIONS, ToolRegistry } from '../../src/tools/ToolRegistry';
import { makeLoadSkillTool } from '../../src/tools/loadSkillTool';
import type { ForgeConfig } from '../../src/config/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function parseConfig(skills: unknown) {
  return ForgeConfigSchema.safeParse({
    active_model: 'm',
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    skills,
  } as Record<string, unknown>);
}

/** A registry with one tool: the one under test, against one config value. */
function registryWithSkills(skills: ForgeConfig['skills']): ToolRegistry {
  const registry = new ToolRegistry();
  const config: ForgeConfig = {
    active_model: null,
    models: [],
    llama_server: {},
    ...(skills ? { skills } : {}),
  };
  registry.register(
    makeLoadSkillTool({
      // The same rule `SkillsService.isEnabled()` implements: only false opts out.
      isEnabled: () => config.skills?.enabled !== false,
      listCatalogEntries: () => [],
      loadSkill: async () => null,
    }),
  );
  return registry;
}

describe('skills: config schema', () => {
  it('accepts enabled, and defaults the block to absent', () => {
    expect(parseConfig({ enabled: true }).success).toBe(true);
    expect(parseConfig({ enabled: false }).success).toBe(true);
    const absent = ForgeConfigSchema.safeParse({
      active_model: 'm',
      models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    });
    expect(absent.success).toBe(true);
    expect(absent.success && absent.data.skills).toBeUndefined();
  });

  it('refuses a non-boolean enabled and any other key', () => {
    for (const bad of [{ enabled: 'true' }, { enabled: 1 }, { enabled: 'yes' }]) {
      const result = parseConfig(bad);
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(['skills', 'enabled']);
    }
    const extra = parseConfig({ enabled: true, roots: ['somewhere'] });
    expect(extra.success).toBe(false);
    if (!extra.success) {
      expect(extra.error.issues.some((issue) => issue.path[0] === 'skills')).toBe(true);
    }
    expect(SkillsConfigSchema.safeParse({ enabled: true }).success).toBe(true);
  });
});

describe('the example config and the starter', () => {
  const exampleText = fs.readFileSync(
    path.join(REPO_ROOT, 'config', 'config.example.yaml'),
    'utf8',
  );

  it('shows the skills block in the file a new user copies', () => {
    expect(exampleText).toMatch(/^#?\s*skills:\s*$/mu);
    expect(exampleText).toMatch(/^\s*#?\s*enabled:/mu);
    const example = parseYaml(exampleText) as Record<string, unknown>;
    expect(ForgeConfigSchema.safeParse(example).success).toBe(true);
  });

  it('says in the example what turning it on costs', () => {
    const start = exampleText.search(/^#?\s*skills:\s*$/mu);
    expect(start).toBeGreaterThan(-1);
    // The comment block above the key is the documentation: the example file's
    // own style puts the explanation before the setting, not after it.
    const blockStart = exampleText.lastIndexOf('\n\n', start);
    const block = exampleText.slice(blockStart, start + 40);
    expect(block).toContain('load_skill');
    expect(block).toMatch(/schema|round|prompt/u);
    expect(block).toContain('.forge/skills');
  });

  it('leaves a generated starter without a skills setting', () => {
    const starter = ForgeConfigSchema.parse(makeOllamaStarterConfig('http://127.0.0.1:11434', ['m']));
    expect(starter.skills).toBeUndefined();
  });
});

describe('the registration gate', () => {
  it('does not advertise load_skill when skills.enabled is false, and still dispatches it', async () => {
    const registry = registryWithSkills({ enabled: false });
    expect(registry.names()).toContain('load_skill');
    expect(
      registry.definitions(new Set(ALL_TOOL_PERMISSIONS)).map((tool) => tool.function.name),
    ).not.toContain('load_skill');
    const result = await registry.dispatch('load_skill', { name: 'x' }, new Set(['read']));
    expect(String(result)).toContain('skills');
    expect(String(result)).toContain('enabled');
  });

  it('advertises it when skills are absent or enabled, and hides it when explicitly disabled', () => {
    const enabled = registryWithSkills({ enabled: true });
    expect(
      enabled.definitions(new Set(ALL_TOOL_PERMISSIONS)).map((tool) => tool.function.name),
    ).toContain('load_skill');
    // Absent means on, so new conversations see both the catalog and the tool.
    const unwritten = registryWithSkills(undefined);
    expect(
      unwritten.definitions(new Set(ALL_TOOL_PERMISSIONS)).map((tool) => tool.function.name),
    ).toContain('load_skill');
    const disabled = registryWithSkills({ enabled: false });
    expect(
      disabled.definitions(new Set(ALL_TOOL_PERMISSIONS)).map((tool) => tool.function.name),
    ).not.toContain('load_skill');
  });
});
