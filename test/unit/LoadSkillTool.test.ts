/**
 * `load_skill` (TOOLS_EXPANSION_PLAN.md Part 2.3, lane F2).
 *
 * The plan's acceptance lines for this tool: it returns the `SKILL.md` body
 * plus the absolute paths of its scripts and references; an unknown name comes
 * back as an error that lists the known skills; it never returns `config.json`
 * contents (that file holds this PC's paths and ports, and the trust rule says
 * a skill grants nothing, so the file is passed to the scripts, not to the
 * model); and the paths it returns are real paths, so a symlinked script that
 * escapes its skill folder is not handed over as if it belonged there.
 *
 * It is also checked here that the tool is eager — ungrouped, like `ask_user` —
 * because a skill the model cannot see is a skill it cannot ask for.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverSkills } from '../../src/skills/discover';
import { loadSkill } from '../../src/skills/loadSkill';
import { SkillsService } from '../../src/skills/skillsService';
import { makeLoadSkillTool } from '../../src/tools/loadSkillTool';
import { lazyGroupForTool, resetLazyToolGroups } from '../../src/tools/lazyToolGroups';
import { ALL_TOOL_PERMISSIONS, ToolRegistry } from '../../src/tools/ToolRegistry';
import type { ForgeConfig } from '../../src/config/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let base: string;
let fakeExtension: string;
let userRoot: string;
let skillFolder: string;

const MANIFEST =
  '---\nname: demo-skill\ndescription: Does the demo thing well.\n---\n\n' +
  '# demo-skill\n\nRun `scripts/run.py` with the shell tool.\n\nSecond body line.\n';

function writeSkill(
  root: string,
  name: string,
  options: { body?: string; scripts?: string[]; references?: string[]; configJson?: string } = {},
): string {
  const folder = path.join(root, name);
  fs.mkdirSync(path.join(folder, 'scripts', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'SKILL.md'),
    `---\nname: ${name}\ndescription: One line about ${name}.\n---\n\n${options.body ?? '# body\n'}`,
    'utf8',
  );
  for (const script of options.scripts ?? []) {
    const target = path.join(folder, 'scripts', ...script.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `#!/usr/bin/env python\nprint("${script}")\n`, 'utf8');
  }
  for (const reference of options.references ?? []) {
    fs.writeFileSync(path.join(folder, 'references', reference), 'notes\n', 'utf8');
  }
  if (options.configJson !== undefined) {
    fs.writeFileSync(path.join(folder, 'config.json'), options.configJson, 'utf8');
  }
  return folder;
}

function serviceFor(configOverrides: Partial<ForgeConfig> = {}): SkillsService {
  const config: ForgeConfig = {
    active_model: null,
    models: [],
    llama_server: {},
    ...configOverrides,
  };
  return new SkillsService({
    getConfig: () => config,
    // A fake install folder inside this file's temp dir: pointing the shipped
    // root at the real repository would make these tests depend on which skills
    // the repository happens to ship.
    extensionPath: fakeExtension,
    home: base,
    getWorkspaceRoot: () => '',
    log: () => undefined,
  });
}

const context = { beforeMutate: () => undefined };

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-load-skill-'));
  fakeExtension = path.join(base, 'extension');
  fs.mkdirSync(fakeExtension, { recursive: true });
  userRoot = path.join(base, '.forge', 'skills');
  fs.mkdirSync(userRoot, { recursive: true });
  skillFolder = writeSkill(userRoot, 'demo-skill', {
    body: MANIFEST.split('---\n\n')[1] ?? '',
    scripts: ['run.py', 'nested/helper.py'],
    references: ['notes.md'],
    configJson: '{"port": 5181, "model": "N:/models/secret.gguf"}\n',
  });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('load_skill', () => {
  it('is registered eager: it belongs to no lazy group', () => {
    resetLazyToolGroups();
    const registry = new ToolRegistry();
    registry.register(makeLoadSkillTool(serviceFor({ skills: { enabled: true } })));
    expect(lazyGroupForTool('load_skill')).toBeUndefined();
    expect(
      registry.definitions(new Set(ALL_TOOL_PERMISSIONS)).map((tool) => tool.function.name),
    ).toContain('load_skill');
  });

  it('returns the SKILL.md body and the real absolute paths of its scripts and references', async () => {
    const tool = makeLoadSkillTool(serviceFor({ skills: { enabled: true } }));
    const result = String(await tool.handler({ name: 'demo-skill' }, context));
    expect(result).toContain('Run `scripts/run.py` with the shell tool.');
    expect(result).toContain('Second body line.');
    for (const expected of ['run.py', 'helper.py', 'notes.md']) {
      expect(result).toContain(expected);
    }
    const shown = result
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim());
    expect(shown.length).toBeGreaterThanOrEqual(3);
    for (const entry of shown) {
      expect(path.isAbsolute(entry), entry).toBe(true);
      expect(fs.existsSync(entry), entry).toBe(true);
    }
    expect(shown).toContain(fs.realpathSync(path.join(skillFolder, 'scripts', 'run.py')));
    expect(shown).toContain(fs.realpathSync(path.join(skillFolder, 'scripts', 'nested', 'helper.py')));
    expect(shown).toContain(fs.realpathSync(path.join(skillFolder, 'references', 'notes.md')));
    expect(result).toContain('shell');
    expect(result).toContain('[user]');
  });

  it('never returns config.json contents, but says the file is there for the scripts', async () => {
    const tool = makeLoadSkillTool(serviceFor({ skills: { enabled: true } }));
    const result = String(await tool.handler({ name: 'demo-skill' }, context));
    expect(result).not.toContain('5181');
    expect(result).not.toContain('secret.gguf');
    expect(result).toContain('config.json');
    expect((result.match(/config\.json/gu) ?? []).length).toBe(1);
  });

  it('a script whose real path leaves the skill folder is not offered as a script path', async () => {
    const escaping = path.join(base, 'outside-run.py');
    fs.writeFileSync(escaping, 'print("outside")\n', 'utf8');
    let made = false;
    try {
      fs.symlinkSync(escaping, path.join(skillFolder, 'scripts', 'run.py'));
      made = true;
    } catch {
      made = false;
    }
    if (!made) return; // no symlink privilege on this machine
    const tool = makeLoadSkillTool(serviceFor({ skills: { enabled: true } }));
    const result = String(await tool.handler({ name: 'demo-skill' }, context));
    expect(result).not.toContain(fs.realpathSync(escaping));
    expect(result).toContain('outside the skill folder');
  });

  it('an unknown name is refused with the known skills listed', async () => {
    writeSkill(userRoot, 'another-skill', { body: '# another\n' });
    const tool = makeLoadSkillTool(serviceFor({ skills: { enabled: true } }));
    const result = String(await tool.handler({ name: 'no-such-skill' }, context));
    expect(result).toContain('Error');
    expect(result).toContain('load_skill');
    expect(result).toContain('demo-skill');
    expect(result).toContain('another-skill');
    expect(result).not.toContain('no-such-skill is a known skill');
  });

  it('an unknown name with nothing installed says so instead of listing an empty set', async () => {
    fs.rmSync(userRoot, { recursive: true, force: true });
    fs.mkdirSync(userRoot, { recursive: true });
    const tool = makeLoadSkillTool(serviceFor({ skills: { enabled: true } }));
    const result = String(await tool.handler({ name: 'anything' }, context));
    expect(result).toContain('Error');
    expect(result).toContain('no skills');
    expect(result).toContain('.forge');
  });

  it('a missing or blank name is refused with the shape to resend', async () => {
    const tool = makeLoadSkillTool(serviceFor({ skills: { enabled: true } }));
    const missing = String(await tool.handler({}, context));
    expect(missing).toContain('name');
    expect(missing).toContain('load_skill {"name": "..."');
    expect(String(await tool.handler({ name: '   ' }, context))).toContain('name');
  });

  it('refuses while skills are off, naming the config line that turns them on', async () => {
    const tool = makeLoadSkillTool(serviceFor());
    // `skills:` absent means off, like every other optional block in `tools:`.
    expect(tool.advertise?.()).toBe(false);
    const on = makeLoadSkillTool(serviceFor({ skills: { enabled: true } }));
    expect(on.advertise?.()).toBe(true);
    const off = makeLoadSkillTool(serviceFor({ skills: { enabled: false } }));
    expect(off.advertise?.()).toBe(false);
    const result = String(await off.handler({ name: 'demo-skill' }, context));
    expect(result).toContain('skills');
    expect(result).toContain('enabled');
  });

  it('the schema is strict: one required name, nothing else', () => {
    const tool = makeLoadSkillTool(serviceFor({ skills: { enabled: true } }));
    const fn = tool.definition.function;
    expect(fn.name).toBe('load_skill');
    expect(fn.parameters).toEqual({
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
      additionalProperties: false,
    });
    expect(tool.permission).toBe('read');
    expect(fn.description.length).toBeLessThanOrEqual(320);
  });
});

describe('loadSkill (the reader behind the tool)', () => {
  it('reports the body from the frontmatter, not the frontmatter itself', async () => {
    const entries = discoverSkills([
      { kind: 'shipped', directory: path.join(base, 'nothing-shipped') },
      { kind: 'user', directory: userRoot },
    ]).skills;
    const loaded = await loadSkill(entries.find((entry) => entry.name === 'demo-skill')!);
    expect(loaded?.body.startsWith('# demo-skill')).toBe(true);
    expect(loaded?.body).not.toContain('description: Does the demo thing well.');
    expect(loaded?.entry.description).toBe('One line about demo-skill.');
  });

  it('lists scripts and references by real path, including one in a sub-folder', async () => {
    const many = writeSkill(userRoot, 'many-scripts', {
      body: '# many\n',
      scripts: Array.from({ length: 40 }, (_unused, index) => `s${index}.py`),
    });
    const entries = discoverSkills([{ kind: 'user', directory: userRoot }]).skills;
    const loaded = await loadSkill(entries.find((entry) => entry.name === 'many-scripts')!);
    expect(loaded?.scripts.length).toBe(40);
    expect(loaded?.scripts[0]).toBe(fs.realpathSync(path.join(many, 'scripts', 's0.py')));
  });

  it('a SKILL.md replaced by a link out of the folder after discovery is not read', async () => {
    const entry = discoverSkills([{ kind: 'user', directory: userRoot }]).skills.find(
      (skill) => skill.name === 'demo-skill',
    )!;
    const marker = 'MARKER-FROM-OUTSIDE-THE-SKILL-FOLDER';
    const outside = path.join(base, 'outside-instructions.md');
    fs.writeFileSync(outside, `${marker}\n`, 'utf8');
    const manifestPath = path.join(skillFolder, 'SKILL.md');
    // The real file has to go first. `fs.symlinkSync` fails with EEXIST on a name
    // that already exists, so a fixture that only tried to put a link over the
    // `SKILL.md` it had written would create no link, return early, and pass
    // without testing anything — which is how this case read green against the
    // unfixed loader the first time it was run.
    fs.rmSync(manifestPath);
    let madeLink = false;
    try {
      fs.symlinkSync(outside, manifestPath);
      madeLink = true;
    } catch {
      madeLink = false;
    }
    if (!madeLink) {
      // The same fallback the discovery symlink cases use: a junction to a folder
      // named SKILL.md exercises the same containment check on a machine without
      // developer mode.
      const outsideDir = path.join(base, 'SKILL.md');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'SKILL.md'), `${marker}\n`, 'utf8');
      try {
        fs.symlinkSync(outsideDir, manifestPath, 'junction');
        madeLink = true;
      } catch {
        return; // no link privilege at all on this machine
      }
    }
    // Assert the premise as well as the conclusion: the manifest now resolves to
    // a path outside the skill folder, so this really is the escape the read has
    // to refuse rather than a fixture that silently made no link.
    const resolvedManifest = fs.realpathSync(manifestPath).toLowerCase();
    expect(resolvedManifest.startsWith(fs.realpathSync(skillFolder).toLowerCase())).toBe(false);
    // `entry` is the one discovery produced BEFORE the file was swapped, which is
    // the frozen-catalog case exactly: the catalog line was built on an earlier
    // turn, and this turn is the one that reads the file. `load_skill` is
    // auto-approved, so what this read returns reaches the transcript with no
    // card — the outside file has to be refused at the read, not at the walk.
    const loaded = await loadSkill(entry);
    expect(loaded.body).not.toContain(marker);
    expect(loaded.readError).toContain('outside');
    expect(loaded.readError).toContain('not read');
    const tool = makeLoadSkillTool({
      isEnabled: () => true,
      listCatalogEntries: () => [entry],
      loadSkillByName: async () => loaded,
    });
    const result = String(await tool.handler({ name: 'demo-skill' }, context));
    expect(result).toContain('could not be read');
    expect(result).toContain('outside');
    expect(result).not.toContain(marker);
  });
});
