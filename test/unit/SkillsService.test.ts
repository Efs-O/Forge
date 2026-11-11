import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TemplateEngine } from '../../src/llm/TemplateEngine';
import { SkillsService } from '../../src/skills/skillsService';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { ForgeConfig } from '../../src/config/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUILTIN_TEMPLATES = path.join(REPO_ROOT, 'config', 'templates', 'builtin');

let base: string;
let fakeExtension: string;
let userRoot: string;
let workspaceRoot: string;
let home: string;

function makeSkill(root: string, name: string): string {
  const folder = path.join(root, name);
  fs.mkdirSync(path.join(folder, 'scripts'), { recursive: true });
  return folder;
}

function writeManifest(folder: string, text: string): void {
  fs.writeFileSync(path.join(folder, 'SKILL.md'), text, 'utf8');
}

function manifest(name: string, description = 'One-line description.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody text.\n`;
}

function conversation(id = 'conv-1'): ConversationRuntime {
  return { id, title: 'test', createdAt: 1, updatedAt: 1, messages: [] };
}

function serviceFor(
  overrides: Partial<ForgeConfig> = {},
  engine: TemplateEngine | undefined = new TemplateEngine(BUILTIN_TEMPLATES),
): SkillsService {
  const config: ForgeConfig = {
    active_model: null,
    models: [],
    llama_server: {},
    ...overrides,
  };
  return new SkillsService({
    getConfig: () => config,
    getTemplateEngine: () => engine,
    extensionPath: fakeExtension,
    home,
    getWorkspaceRoot: () => workspaceRoot,
    log: () => undefined,
  });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skills-service-'));
  fakeExtension = path.join(base, 'extension');
  fs.mkdirSync(fakeExtension, { recursive: true });
  home = path.join(base, 'home');
  userRoot = path.join(home, '.forge', 'skills');
  workspaceRoot = path.join(base, 'workspace');
  fs.mkdirSync(userRoot, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, '.forge', 'skills'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('SkillsService', () => {
  it('builds the catalog once and keeps handing back the same string, even when a skill is added between calls', () => {
    makeSkill(userRoot, 'first');
    writeManifest(path.join(userRoot, 'first'), manifest('first', 'First skill.'));
    const service = serviceFor({ skills: { enabled: true } });
    const conv = conversation();
    const firstBuild = service.catalogFor(conv)!;
    expect(firstBuild).toContain('First skill.');
    expect(firstBuild).not.toContain('Second skill.');

    makeSkill(userRoot, 'second');
    writeManifest(path.join(userRoot, 'second'), manifest('second', 'Second skill.'));
    expect(service.catalogFor(conv)).toBe(firstBuild);

    const fresh = service.catalogFor(conversation('conv-2'))!;
    expect(fresh).toContain('Second skill.');
  });

  it('records the frozen catalog and the roots it was built from on the conversation', () => {
    makeSkill(userRoot, 'first');
    writeManifest(path.join(userRoot, 'first'), manifest('first'));
    const service = serviceFor({ skills: { enabled: true } });
    const conv = conversation();
    service.catalogFor(conv);
    expect(conv.skillsCatalog).toBeTypeOf('string');
    expect(conv.skillsCatalogSignature).toBeTypeOf('string');
    expect(conv.skillsCatalog).toBe(service.catalogFor(conv));
  });

  it('lists skills when config is absent and omits the catalog only when explicitly disabled', () => {
    makeSkill(userRoot, 'first');
    writeManifest(path.join(userRoot, 'first'), manifest('first'));
    let config: ForgeConfig = {
      active_model: null,
      models: [],
      llama_server: {},
      skills: { enabled: false },
    };
    const service = new SkillsService({
      getConfig: () => config,
      extensionPath: fakeExtension,
      home,
      getWorkspaceRoot: () => workspaceRoot,
      log: () => undefined,
    });
    const conv = conversation();
    expect(service.catalogFor(conv)).toBeUndefined();
    expect(conv.skillsCatalog).toBeUndefined();
    config = { active_model: null, models: [], llama_server: {} };
    expect(service.catalogFor(conv)).toContain('first');
  });

  it('rebuilds for a new conversation when the workspace folder changes, and never for a skill added in place', () => {
    makeSkill(path.join(workspaceRoot, '.forge', 'skills'), 'ws');
    writeManifest(
      path.join(workspaceRoot, '.forge', 'skills', 'ws'),
      manifest('ws', 'First workspace.'),
    );
    let workspace = workspaceRoot;
    const service = new SkillsService({
      getConfig: () => ({
        active_model: null,
        models: [],
        llama_server: {},
        skills: { enabled: true },
      }),
      extensionPath: fakeExtension,
      home,
      getWorkspaceRoot: () => workspace,
      log: () => undefined,
    });
    const conv = conversation();
    expect(service.catalogFor(conv)).toContain('First workspace.');
    makeSkill(path.join(workspace, '.forge', 'skills'), 'added-in-place');
    writeManifest(
      path.join(workspace, '.forge', 'skills', 'added-in-place'),
      manifest('added-in-place', 'Added while the chat runs.'),
    );
    expect(service.catalogFor(conv)).toContain('First workspace.');
    workspace = path.join(base, 'other-workspace');
    fs.mkdirSync(path.join(workspace, '.forge', 'skills'), { recursive: true });
    writeManifest(
      makeSkill(path.join(workspace, '.forge', 'skills'), 'ws'),
      manifest('ws', 'Second workspace.'),
    );
    const rebuilt = service.catalogFor(conv)!;
    expect(rebuilt).toContain('Second workspace.');
    expect(rebuilt).not.toContain('First workspace.');
  });

  it('logs each skipped skill once, not once per turn', () => {
    const logged: string[] = [];
    makeSkill(userRoot, 'broken');
    writeManifest(path.join(userRoot, 'broken'), '# nothing to parse\n');
    const service = new SkillsService({
      getConfig: () => ({
        active_model: null,
        models: [],
        llama_server: {},
        skills: { enabled: true },
      }),
      getTemplateEngine: () => new TemplateEngine(BUILTIN_TEMPLATES),
      extensionPath: fakeExtension,
      home,
      getWorkspaceRoot: () => workspaceRoot,
      log: (message) => logged.push(message),
    });
    service.catalogFor(conversation('a'));
    service.catalogFor(conversation('b'));
    service.catalogFor(conversation('c'));
    const aboutBroken = logged.filter((message) => message.includes('broken'));
    expect(aboutBroken).toHaveLength(1);
    expect(aboutBroken[0]).toContain('user');
  });

  it('lists the current skills for load_skill, including one added after this conversation started', () => {
    makeSkill(userRoot, 'first');
    writeManifest(path.join(userRoot, 'first'), manifest('first'));
    const service = serviceFor({ skills: { enabled: true } });
    const conv = conversation();
    service.catalogFor(conv);
    makeSkill(userRoot, 'later');
    writeManifest(path.join(userRoot, 'later'), manifest('later'));
    expect(service.listCatalogEntries().map((entry) => entry.name)).toEqual(['first', 'later']);
  });
});
