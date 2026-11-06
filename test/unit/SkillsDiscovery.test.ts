/**
 * Skills (TOOLS_EXPANSION_PLAN.md Part 2, lane F2).
 *
 * What these tests pin, in the plan's own words:
 * - the three roots (shipped `resources/skills/`, `~/.forge/skills/`,
 *   `<workspace>/.forge/skills/`) and that a later root wins;
 * - `SKILL.md` frontmatter: `name` must equal the folder name, `description`
 *   must be one line, and a skill that fails either is skipped WITH a reason
 *   while its neighbours still load (the ledger's "Crash mid-write" cell);
 * - symlink resolution: a `SKILL.md` whose real path leaves its skill folder
 *   is skipped, and the paths the model is given are real paths;
 * - the catalog: one line per skill, the root named on each line, shadowing
 *   reported, 4,000-character cap;
 * - the catalog is built once and frozen for its conversation, so adding a
 *   skill cannot rewrite a running chat's prompt prefix.
 *
 * Fixtures live in this file's own temp folder (the temp guard gives each test
 * file one) and are removed in `afterEach`; the shipped-template case points the
 * engine at the real `config/templates/builtin/`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TemplateEngine } from '../../src/llm/TemplateEngine';
import {
  discoverSkills,
  parseSkillManifest,
  skillRoots,
  type SkillRoot,
} from '../../src/skills/discover';
import { renderCatalog } from '../../src/skills/catalog';
import { SkillsService } from '../../src/skills/skillsService';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { ForgeConfig } from '../../src/config/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUILTIN_TEMPLATES = path.join(REPO_ROOT, 'config', 'templates', 'builtin');

let base: string;
let fakeExtension: string;
let shippedRoot: string;
let userRoot: string;
let workspaceRoot: string;
/** The workspace root's own skills folder, which is what the workspace root is. */
let workspaceSkills: string;
let home: string;

function makeSkill(root: string, name: string, body = '# instructions\n\nDo the thing.\n'): string {
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

function roots(): [SkillRoot, SkillRoot, SkillRoot] {
  return [
    { kind: 'shipped', directory: shippedRoot },
    { kind: 'user', directory: userRoot },
    { kind: 'workspace', directory: workspaceSkills },
  ];
}

/** A conversation object only as big as these tests need. */
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

/** True when this machine can make a file symlink at all is tested by the
 * `try` blocks in the symlink cases themselves, which skip silently when the
 * machine cannot: a CI runner without developer mode must not fail the suite. */

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skills-'));
  fakeExtension = path.join(base, 'extension');
  fs.mkdirSync(fakeExtension, { recursive: true });
  home = path.join(base, 'home');
  shippedRoot = path.join(base, 'shipped');
  userRoot = path.join(home, '.forge', 'skills');
  workspaceRoot = path.join(base, 'workspace');
  fs.mkdirSync(shippedRoot, { recursive: true });
  fs.mkdirSync(userRoot, { recursive: true });
  workspaceSkills = path.join(workspaceRoot, '.forge', 'skills');
  fs.mkdirSync(workspaceSkills, { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ── frontmatter parse ─────────────────────────────────────────────────────────

describe('parseSkillManifest', () => {
  it('accepts a well-formed manifest and reports where the body starts', () => {
    const parsed = parseSkillManifest(manifest('hf-download'), 'hf-download');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.name).toBe('hf-download');
    expect(parsed.description).toBe('One-line description.');
    const content = manifest('hf-download');
    expect(content.slice(parsed.bodyStart)).toBe('\n# hf-download\n\nBody text.\n');
  });

  it('refuses a name that is not the folder name', () => {
    const parsed = parseSkillManifest(manifest('wrong-name'), 'hf-download');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('name');
    expect(parsed.reason).toContain('wrong-name');
    expect(parsed.reason).toContain('hf-download');
  });

  it('refuses a missing name, a missing description and no frontmatter at all', () => {
    expect(parseSkillManifest('---\ndescription: fine\n---\nbody\n', 'x').ok).toBe(false);
    expect(parseSkillManifest('---\nname: x\n---\nbody\n', 'x').ok).toBe(false);
    const noFence = parseSkillManifest('# just a document\n', 'x');
    expect(noFence.ok).toBe(false);
    expect(noFence.reason).toContain('---');
  });

  it('refuses a description that wraps to a second line', () => {
    const wrapped = '---\nname: x\ndescription: first line\nand the sentence continues\n---\nbody\n';
    const parsed = parseSkillManifest(wrapped, 'x');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('one line');
  });

  it('refuses a description that is empty or only spaces', () => {
    expect(parseSkillManifest('---\nname: x\ndescription:   \n---\nbody\n', 'x').ok).toBe(false);
    expect(parseSkillManifest('---\nname: x\ndescription:\n---\nbody\n', 'x').ok).toBe(false);
  });

  it('refuses a name that is not a single folder-safe word', () => {
    expect(parseSkillManifest('---\nname: ../escape\ndescription: d\n---\nbody\n', 'x').ok).toBe(
      false,
    );
    expect(parseSkillManifest('---\nname: a b\ndescription: d\n---\nbody\n', 'x').ok).toBe(false);
    expect(parseSkillManifest('---\nname: \ndescription: d\n---\nbody\n', 'x').ok).toBe(false);
  });

  it('reads a CRLF manifest the same way', () => {
    const crlf = manifest('x').replace(/\n/gu, '\r\n');
    const parsed = parseSkillManifest(crlf, 'x');
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  });
});

// ── discovery ─────────────────────────────────────────────────────────────────

describe('discoverSkills', () => {
  it('finds a skill under each of the three roots and names the root on each line', () => {
    makeSkill(shippedRoot, 'shipped-one');
    writeManifest(path.join(shippedRoot, 'shipped-one'), manifest('shipped-one', 'Shipped line.'));
    makeSkill(userRoot, 'user-two');
    writeManifest(path.join(userRoot, 'user-two'), manifest('user-two', 'User line.'));
    makeSkill(path.join(workspaceRoot, '.forge', 'skills'), 'workspace-three');
    writeManifest(
      path.join(workspaceRoot, '.forge', 'skills', 'workspace-three'),
      manifest('workspace-three', 'Workspace line.'),
    );

    const discovered = discoverSkills(roots());
    expect(discovered.skipped).toEqual([]);
    expect(discovered.skills.map((entry) => entry.name)).toEqual([
      'shipped-one',
      'user-two',
      'workspace-three',
    ]);
    expect(discovered.skills.map((entry) => entry.root)).toEqual([
      'shipped',
      'user',
      'workspace',
    ]);
    const lines = discovered.skills.map((entry) =>
      renderCatalog(undefined, [entry]).text.split('\n').filter((line) => line.startsWith('- ')),
    );
    expect(lines[0][0]).toContain('[shipped]');
    expect(lines[1][0]).toContain('[user]');
    expect(lines[2][0]).toContain('[workspace]');
  });

  it('a workspace skill shadows the user one of the same name, and the winner says so', () => {
    makeSkill(shippedRoot, 'shared');
    writeManifest(path.join(shippedRoot, 'shared'), manifest('shared', 'Shipped description.'));
    makeSkill(userRoot, 'shared');
    writeManifest(path.join(userRoot, 'shared'), manifest('shared', 'User description.'));
    makeSkill(path.join(workspaceRoot, '.forge', 'skills'), 'shared');
    writeManifest(
      path.join(workspaceRoot, '.forge', 'skills', 'shared'),
      manifest('shared', 'Workspace description.'),
    );

    const discovered = discoverSkills(roots());
    expect(discovered.skills).toHaveLength(1);
    const winner = discovered.skills[0]!;
    expect(winner.root).toBe('workspace');
    expect(winner.description).toBe('Workspace description.');
    expect(winner.shadowNote).toContain('shadows');
    expect(winner.shadowNote).toContain('user');
    expect(winner.shadowNote).toContain('shipped');

    const catalog = renderCatalog(undefined, discovered.skills).text;
    expect(catalog).toContain('Workspace description.');
    expect(catalog).not.toContain('User description.');
    expect(catalog).not.toContain('Shipped description.');
    expect(catalog).toContain('shadows');
  });

  it('a user skill shadows the shipped one, with the same root shown', () => {
    makeSkill(shippedRoot, 'hf-download');
    writeManifest(
      path.join(shippedRoot, 'hf-download'),
      manifest('hf-download', 'Generic shipped text.'),
    );
    makeSkill(userRoot, 'hf-download');
    writeManifest(path.join(userRoot, 'hf-download'), manifest('hf-download', 'This PC text.'));

    const discovered = discoverSkills(roots());
    expect(discovered.skills).toHaveLength(1);
    expect(discovered.skills[0]!.root).toBe('user');
    expect(discovered.skills[0]!.shadowNote).toContain('shadows the [shipped]');
    expect(renderCatalog(undefined, discovered.skills).text).toContain('This PC text.');
  });

  it('skips a broken skill with a reason and still loads its neighbours', () => {
    makeSkill(userRoot, 'good-one');
    writeManifest(path.join(userRoot, 'good-one'), manifest('good-one'));
    makeSkill(userRoot, 'broken-one');
    writeManifest(path.join(userRoot, 'broken-one'), '# no frontmatter at all\n');
    makeSkill(userRoot, 'wrong-name');
    writeManifest(path.join(userRoot, 'wrong-name'), manifest('other-name'));
    fs.mkdirSync(path.join(userRoot, 'no-manifest'), { recursive: true });
    fs.writeFileSync(path.join(userRoot, 'not-a-folder.txt'), 'a file, not a folder', 'utf8');

    const discovered = discoverSkills(roots());
    expect(discovered.skills.map((entry) => entry.name)).toEqual(['good-one']);
    const reasons = discovered.skipped.map((skip) => skip.reason);
    expect(reasons.some((reason) => reason.includes('---'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('name'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('SKILL.md'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('not a folder'))).toBe(true);
    expect(discovered.skipped.map((skip) => skip.name).sort()).toEqual([
      'broken-one',
      'no-manifest',
      'not-a-folder.txt',
      'wrong-name',
    ]);
    for (const skip of discovered.skipped) expect(skip.root).toBe('user');
  });

  it('a half-written SKILL.md is skipped with a reason, not a crash', () => {
    makeSkill(userRoot, 'half-written');
    fs.writeFileSync(
      path.join(userRoot, 'half-written', 'SKILL.md'),
      '---\nname: half-written\ndesc',
      'utf8',
    );
    makeSkill(userRoot, 'good-two');
    writeManifest(path.join(userRoot, 'good-two'), manifest('good-two'));
    const discovered = discoverSkills(roots());
    expect(discovered.skills.map((entry) => entry.name)).toEqual(['good-two']);
    expect(discovered.skipped[0]!.name).toBe('half-written');
  });

  it('a folder that is a symlink into the same root resolves, and the name rule is applied to the link name', () => {
    const real = makeSkill(userRoot, 'real-folder');
    const link = path.join(userRoot, 'linked');
    try {
      fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // No symlink privilege on this machine: the junction case cannot be made here.
      return;
    }
    // The target's manifest names the target folder, so the link is skipped for a
    // name mismatch — that is the name rule working through the resolved path,
    // not a symlink bug, and it is why the reason must name both spellings.
    writeManifest(real, manifest('real-folder'));
    let discovered = discoverSkills(roots());
    expect(discovered.skills.map((entry) => entry.name)).toEqual(['real-folder']);
    const skip = discovered.skipped.find((entry) => entry.name === 'linked');
    expect(skip).toBeDefined();
    expect(skip!.reason).toContain('name');
    // The same link loads once its SKILL.md names the link, and the entry reports
    // the resolved folder rather than the link path. The folder itself is then the
    // one skipped, for the mirror-image reason: one manifest, two names.
    writeManifest(real, manifest('linked'));
    discovered = discoverSkills(roots());
    expect(discovered.skills.map((entry) => entry.name)).toEqual(['linked']);
    expect(discovered.skipped.map((entry) => entry.name)).toEqual(['real-folder']);
    expect(fs.realpathSync(discovered.skills[0]!.folderPath)).toBe(fs.realpathSync(real));
  });

  it('a SKILL.md whose real path leaves the skill folder is skipped with a reason', () => {
    const folder = makeSkill(userRoot, 'escaping');
    const outside = path.join(base, 'outside-SKILL.md');
    fs.writeFileSync(outside, manifest('escaping'), 'utf8');
    let madeLink = false;
    try {
      fs.symlinkSync(outside, path.join(folder, 'SKILL.md'));
      madeLink = true;
    } catch {
      madeLink = false;
    }
    if (!madeLink) {
      // Windows without developer mode: a junction to a folder whose name is
      // SKILL.md resolves the same way and exercises the same check.
      const outsideDir = path.join(base, 'SKILL.md');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'SKILL.md'), manifest('escaping'), 'utf8');
      try {
        fs.symlinkSync(outsideDir, path.join(folder, 'SKILL.md'), 'junction');
        madeLink = true;
      } catch {
        return;
      }
    }
    const discovered = discoverSkills(roots());
    expect(discovered.skills).toEqual([]);
    const skip = discovered.skipped.find((entry) => entry.name === 'escaping');
    expect(skip).toBeDefined();
    expect(skip!.reason).toContain('outside');
    expect(skip!.reason).toContain('folder');
  });

  it('a skill folder that is a link to the root itself is skipped, not loaded', () => {
    const inside = makeSkill(userRoot, 'real-one');
    writeManifest(inside, manifest('real-one'));
    const selfLink = path.join(userRoot, 'is-the-root');
    try {
      fs.symlinkSync(userRoot, selfLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // no link privilege on this machine
    }
    // Reading "inside the root" as "same path or below" would load this: its
    // SKILL.md is inside the root by that reading and its name matches the link.
    // The root is not a skill folder inside itself, and one folder that resolves
    // to the root would stand for every skill in it, so the check is strict.
    writeManifest(userRoot, manifest('is-the-root'));
    const discovered = discoverSkills(roots());
    const skip = discovered.skipped.find((entry) => entry.name === 'is-the-root');
    expect(skip).toBeDefined();
    expect(skip!.reason).toContain('root');
    expect(discovered.skills.map((entry) => entry.name)).toEqual(['real-one']);
  });

  it('a root whose own path runs through a junction still lists its skills', () => {
    const target = path.join(base, 'moved-skills');
    const skill = makeSkill(target, 'through-junction');
    writeManifest(skill, manifest('through-junction'));
    const linkRoot = path.join(base, 'junction-skills');
    try {
      fs.symlinkSync(target, linkRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // no link privilege on this machine
    }
    // The root path is itself the link, so every folder under it realpaths to
    // `target` rather than to `linkRoot`. Measured against the unresolved root
    // path they all look "outside", and the whole root vanishes with no skill
    // skipped — which is what happens on a PC where ~/.forge/skills is a junction
    // to another drive, or where the workspace is opened through one.
    const discovered = discoverSkills([{ kind: 'user', directory: linkRoot }]);
    expect(discovered.skipped.map((entry) => entry.reason).join(' | ')).toBe('');
    expect(discovered.skills.map((entry) => entry.name)).toEqual(['through-junction']);
    expect(discovered.skills[0]!.folderPath).toBe(fs.realpathSync(skill));
  });

  it('a missing root contributes nothing and is not reported as a broken skill', () => {
    makeSkill(userRoot, 'only-one');
    writeManifest(path.join(userRoot, 'only-one'), manifest('only-one'));
    const discovered = discoverSkills([
      { kind: 'shipped', directory: path.join(base, 'no-such-folder') },
      ...roots().slice(1),
    ]);
    expect(discovered.skills.map((entry) => entry.name)).toEqual(['only-one']);
    expect(discovered.skipped).toEqual([]);
  });
});

// ── roots ─────────────────────────────────────────────────────────────────────

describe('skillRoots', () => {
  it('lists the three roots in the order later ones win', () => {
    const found = skillRoots({
      extensionPath: REPO_ROOT,
      home,
      workspaceRoot,
      userSkillsDirectory: path.join(home, '.forge', 'skills'),
      workspaceSkillsDirectory: path.join(workspaceRoot, '.forge', 'skills'),
    });
    expect(found.map((root) => root.kind)).toEqual(['shipped', 'user', 'workspace']);
    expect(found[0]!.directory).toBe(path.join(REPO_ROOT, 'resources', 'skills'));
    expect(found[1]!.directory).toBe(path.join(home, '.forge', 'skills'));
    expect(found[2]!.directory).toBe(path.join(workspaceRoot, '.forge', 'skills'));
  });

  it('drops a root that has no workspace folder, and a workspace with no skills folder', () => {
    const found = skillRoots({ extensionPath: REPO_ROOT, home });
    expect(found.map((root) => root.kind)).toEqual(['shipped', 'user']);
    const noWorkspace = skillRoots({ extensionPath: REPO_ROOT, home, workspaceRoot: '' });
    expect(noWorkspace.map((root) => root.kind)).toEqual(['shipped', 'user']);
  });
});

// ── catalog rendering ─────────────────────────────────────────────────────────

describe('renderCatalog', () => {
  it('renders nothing when there are no skills, so the prompt does not gain an empty block', () => {
    expect(renderCatalog(undefined, []).text).toBe('');
  });

  it('explains load_skill and the trust rule in the header', () => {
    makeSkill(userRoot, 'one-skill');
    writeManifest(path.join(userRoot, 'one-skill'), manifest('one-skill'));
    const catalog = renderCatalog(undefined, discoverSkills(roots()).skills).text;
    expect(catalog).toContain('load_skill');
    expect(catalog).toContain('shell');
    expect(catalog).toContain('grant');
    expect(catalog).toContain('- [user] one-skill — One-line description.');
  });

  it('caps the catalog at 4,000 characters and says how many lines were cut', () => {
    for (let index = 0; index < 120; index += 1) {
      const name = `skill-${String(index).padStart(3, '0')}`;
      const folder = makeSkill(userRoot, name);
      writeManifest(
        folder,
        manifest(name, `Description number ${index} that is long enough to matter.`.padEnd(180)),
      );
    }
    const discovered = discoverSkills(roots());
    expect(discovered.skills.length).toBeGreaterThan(100);
    const rendered = renderCatalog(new TemplateEngine(BUILTIN_TEMPLATES), discovered.skills);
    expect(rendered.text.length).toBeLessThanOrEqual(4_000);
    expect(rendered.omitted).toBeGreaterThan(0);
    const shown = discovered.skills.length - rendered.omitted;
    expect(rendered.text).toContain(`${shown} of ${discovered.skills.length} skills shown`);
    expect(rendered.text).toContain(`${rendered.omitted} not listed`);
    expect(rendered.text).toContain('skill-000');
    expect(rendered.text).not.toContain(`skill-${String(119).padStart(3, '0')}`);
  });

  it('uses the builtin skills.njk template, and falls back to plain text when it cannot render', () => {
    makeSkill(userRoot, 'template-skill');
    writeManifest(path.join(userRoot, 'template-skill'), manifest('template-skill'));
    const entries = discoverSkills(roots()).skills;
    const viaTemplate = renderCatalog(new TemplateEngine(BUILTIN_TEMPLATES), entries);
    const viaFallback = renderCatalog(new TemplateEngine(path.join(base, 'no-templates')), entries);
    expect(viaTemplate.text).toContain('Available skills');
    expect(viaFallback.text).toContain('Available skills');
    expect(viaFallback.text).toContain('- [user] template-skill — One-line description.');
    expect(viaFallback.log).toContain('skills.njk');
  });
});

// ── the frozen, per-conversation catalog ──────────────────────────────────────

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

    // A conversation that starts after the skill exists does see it.
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
      getConfig: () => ({ active_model: null, models: [], llama_server: {}, skills: { enabled: true } }),
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
      getConfig: () => ({ active_model: null, models: [], llama_server: {}, skills: { enabled: true } }),
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
