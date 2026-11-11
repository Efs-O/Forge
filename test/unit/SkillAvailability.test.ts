import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSkillManifest, type SkillEntry } from '../../src/skills/discover';
import { catalogHeaderLines, renderCatalog } from '../../src/skills/catalog';
import { SkillsService } from '../../src/skills/skillsService';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { ForgeConfig } from '../../src/config/types';
import { isLazyGroupActive, resetLazyToolGroups } from '../../src/tools/lazyToolGroups';

const HEADER =
  'Available skills (load one with load_skill {"name": "..."}; it returns the SKILL.md text and the real paths of its scripts):\n' +
  "Run a skill's scripts through shell, under the usual approvals: a skill grants no permission, and a workspace skill comes from the open repo. Read its scripts only when the skill says to.";

let base: string;
let extensionPath: string;
let home: string;
let skillsRoot: string;

function writeSkill(name: string, requiresTools: readonly string[]): string {
  const folder = path.join(skillsRoot, name);
  fs.mkdirSync(folder, { recursive: true });
  const requirements = requiresTools.length ? `requires_tools: ${requiresTools.join(', ')}\n` : '';
  fs.writeFileSync(
    path.join(folder, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Needs ${requiresTools.join(' and ') || 'no tools'}.\n${requirements}---\n\n# ${name}\n`,
    'utf8',
  );
  return folder;
}

function serviceFor(): SkillsService {
  const config: ForgeConfig = {
    active_model: null,
    models: [],
    llama_server: {},
    skills: { enabled: true },
  };
  return new SkillsService({
    getConfig: () => config,
    extensionPath,
    home,
    getWorkspaceRoot: () => '',
    log: () => undefined,
  });
}

function registerTool(registry: ToolRegistry, name: string): void {
  registry.register({
    definition: {
      type: 'function',
      function: {
        name,
        description: 'Test tool.',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    },
    permission: 'read',
    handler: async () => 'ok',
  });
}

beforeEach(() => {
  resetLazyToolGroups();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skill-availability-'));
  extensionPath = path.join(base, 'extension');
  home = path.join(base, 'home');
  skillsRoot = path.join(home, '.forge', 'skills');
  fs.mkdirSync(path.join(extensionPath, 'resources', 'skills'), { recursive: true });
  fs.mkdirSync(skillsRoot, { recursive: true });
});

afterEach(() => {
  resetLazyToolGroups();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('skill tool requirements', () => {
  it('parses requires_tools as a comma-separated scalar and defaults it to empty', () => {
    const parsed = parseSkillManifest(
      '---\nname: media-skill\ndescription: Uses media tools.\n' +
        'requires_tools: generate_music, generate_video\n---\n\n# body\n',
      'media-skill',
    );
    const plain = parseSkillManifest(
      '---\nname: plain-skill\ndescription: No requirements.\n---\n\n# body\n',
      'plain-skill',
    );
    expect(parsed.ok).toBe(true);
    expect(plain.ok).toBe(true);
    if (!parsed.ok || !plain.ok) return;
    expect(parsed.requiresTools).toEqual(['generate_music', 'generate_video']);
    expect(plain.requiresTools).toEqual([]);
  });

  it('renders the exact two-line catalog header', () => {
    const entry: SkillEntry = {
      name: 'probe',
      description: 'One-line description.',
      requiresTools: [],
      root: 'user',
      linkPath: '/skills/probe',
      folderPath: '/skills/probe',
    };
    expect(catalogHeaderLines().join('\n')).toBe(HEADER);
    expect(renderCatalog(undefined, [entry]).text).toBe(
      `${HEADER}\n- [user] probe — One-line description.`,
    );
  });

  it('omits music and video skills when their required tools are not registered', () => {
    writeSkill('music-track', ['generate_music']);
    writeSkill('video-clip', ['generate_video']);
    const service = serviceFor();
    expect(service.catalogFor(undefined)).toBeUndefined();
    expect(service.listCatalogEntries()).toEqual([]);
  });

  it('lists registered media tools while their lazy group remains unloaded', () => {
    writeSkill('music-track', ['generate_music']);
    writeSkill('video-clip', ['generate_video']);
    const registry = new ToolRegistry();
    registerTool(registry, 'generate_music');
    registerTool(registry, 'generate_video');
    expect(registry.names()).toEqual(['generate_music', 'generate_video']);
    expect(isLazyGroupActive('unloaded-conversation', 'media')).toBe(false);
    const service = serviceFor();
    expect(service.catalogFor(undefined)).toContain('- [user] music-track');
    expect(service.catalogFor(undefined)).toContain('- [user] video-clip');
    expect(service.listCatalogEntries().map((entry) => entry.name)).toEqual([
      'music-track',
      'video-clip',
    ]);
  });
});
