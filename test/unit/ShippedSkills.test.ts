/**
 * The shipped skill folder (lane F2, item 4) — and the CI-enforced row of the
 * plan's `State × lifecycle ledger`:
 *
 * > a vitest test walks `resources/skills/` and fails if any folder lacks a
 * > parseable `SKILL.md` with `name` equal to the folder name and a one-line
 * > `description`
 *
 * That row is the whole reason a shipped skill cannot ship half-written: the
 * loader skips a skill whose frontmatter does not parse, so an unparseable
 * shipped `SKILL.md` would be a skill that silently never reaches a user.
 *
 * The checks that `test/unit/ShippedHelperScripts.test.ts` carried for
 * `tools/user/` move here with the folder: nothing ships undocumented, the
 * markdown survives packaging, the starter file points at what now exists, and
 * no shipped script carries a key (a shipped script is copied onto other
 * machines by definition).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { discoverSkills, parseSkillManifest } from '../../src/skills/discover';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'resources', 'skills');
const LAB_SKILLS_ROOT = path.join(REPO_ROOT, 'skills-lab');
// The account's own profile, not the throwaway home `tempGuard.setup.ts` gives a
// test file: what this compares is the `hf-download` skill the operator installed
// for themselves, so it has to be read where that install lives. `userInfo()`
// reads the account (the token's profile folder on Windows, the passwd entry
// elsewhere) and ignores the `USERPROFILE` / `HOME` the guard redirects.
const USER_SKILL_SCRIPT = path.join(
  os.userInfo().homedir,
  '.forge',
  'skills',
  'hf-download',
  'scripts',
  'hf_parallel_dl.py',
);

/** Every skill folder below the shipped root, whatever the release ships. */
function shippedFolders(): string[] {
  if (!fs.existsSync(SKILLS_ROOT)) return [];
  return fs
    .readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function labFolders(): string[] {
  if (!fs.existsSync(LAB_SKILLS_ROOT)) return [];
  return fs
    .readdirSync(LAB_SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe('resources/skills/ (the shipped skill folder)', () => {
  it('holds at least one skill, so the feature is not shipped empty', () => {
    expect(shippedFolders()).not.toEqual([]);
  });

  it('every folder parses with the real loader, name equal to the folder name', () => {
    // The loader's own discovery is the check: a folder it would skip in front
    // of a user must not survive here either.
    const discovered = discoverSkills([{ kind: 'shipped', directory: SKILLS_ROOT }]);
    expect(discovered.skipped.map((skip) => `${skip.name}: ${skip.reason}`)).toEqual([]);
    const found = discovered.skills.map((entry) => entry.name).sort();
    expect(found).toEqual(shippedFolders().sort());
    expect(found).toContain('hf-download');
    for (const entry of discovered.skills) {
      expect(fs.readFileSync(path.join(entry.folderPath, 'SKILL.md'), 'utf8')).toContain(
        entry.description,
      );
    }
  });

  it('every SKILL.md has frontmatter whose name matches its folder and a one-line description', () => {
    for (const folder of shippedFolders()) {
      const manifestPath = path.join(SKILLS_ROOT, folder, 'SKILL.md');
      expect(fs.existsSync(manifestPath), `${folder}/SKILL.md missing`).toBe(true);
      const parsed = parseSkillManifest(fs.readFileSync(manifestPath, 'utf8'), folder);
      expect(parsed.ok, `${folder}: ${parsed.ok ? '' : parsed.reason}`).toBe(true);
    }
  });

  it('marks the media skills with the tool each one requires', () => {
    const music = parseSkillManifest(
      fs.readFileSync(path.join(SKILLS_ROOT, 'music-track', 'SKILL.md'), 'utf8'),
      'music-track',
    );
    const video = parseSkillManifest(
      fs.readFileSync(path.join(SKILLS_ROOT, 'video-clip', 'SKILL.md'), 'utf8'),
      'video-clip',
    );
    expect(music.ok).toBe(true);
    expect(video.ok).toBe(true);
    if (!music.ok || !video.ok) return;
    expect(music.requiresTools).toEqual(['generate_music']);
    expect(video.requiresTools).toEqual(['generate_video']);
  });

  it("ships hf-download with its script, byte-identical to the owner's user skill", () => {
    const script = path.join(SKILLS_ROOT, 'hf-download', 'scripts', 'hf_parallel_dl.py');
    expect(fs.existsSync(script)).toBe(true);
    if (!fs.existsSync(USER_SKILL_SCRIPT)) {
      // The comparison the plan asks for can only run where the user skill
      // exists — CI runners have no ~/.forge/skills, so there it is skipped.
      expect(fs.existsSync(USER_SKILL_SCRIPT)).toBe(false);
      return;
    }
    expect(fs.readFileSync(script)).toEqual(fs.readFileSync(USER_SKILL_SCRIPT));
  });

  it('the shipped script holds no key literal and reads the token from the environment', () => {
    const script = fs.readFileSync(
      path.join(SKILLS_ROOT, 'hf-download', 'scripts', 'hf_parallel_dl.py'),
      'utf8',
    );
    const literals = [...script.matchAll(/(key|token|secret)\s*=\s*["'][^"']{6,}["']/g)].map(
      (match) => match[0],
    );
    expect(literals).toEqual([]);
    expect(script).toContain('os.environ.get("HF_TOKEN")');
  });

  it('the shipped script needs no installs — standard library only', () => {
    const stdlib = new Set([
      'argparse',
      'base64',
      'collections',
      'concurrent',
      'contextlib',
      'csv',
      'dataclasses',
      'datetime',
      'enum',
      'fnmatch',
      'functools',
      'glob',
      'hashlib',
      'http',
      'io',
      'json',
      'logging',
      'math',
      'os',
      'pathlib',
      'platform',
      'random',
      're',
      'shutil',
      'socket',
      'ssl',
      'string',
      'struct',
      'subprocess',
      'sys',
      'tempfile',
      'textwrap',
      'threading',
      'time',
      'typing',
      'urllib',
      'uuid',
      'zlib',
    ]);
    const script = fs.readFileSync(
      path.join(SKILLS_ROOT, 'hf-download', 'scripts', 'hf_parallel_dl.py'),
      'utf8',
    );
    const imports = [...script.matchAll(/^(?:import|from)\s+([a-z_][a-z0-9_]*)/gm)].map(
      (match) => match[1]!,
    );
    expect(imports.length).toBeGreaterThan(0);
    expect([...new Set(imports.filter((name) => !stdlib.has(name)))]).toEqual([]);
  });

  it('the SKILL.md survives packaging, where `**/*.md` below the root would strip it', () => {
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.vscodeignore'), 'utf8').split('\n');
    expect(ignore).toContain('!resources/skills/**/SKILL.md');
    expect(ignore).toContain('!resources/skills/**/*.py');
    expect(ignore).toContain('!resources/skills/**/*.md');
  });

  it('the starter FORGE.md a new workspace gets points at skills, not the retired folder', () => {
    const starter = fs.readFileSync(
      path.join(REPO_ROOT, 'resources/instructions/FORGE.starter.md'),
      'utf8',
    );
    expect(starter).toContain('load_skill');
    expect(starter).toContain('.forge/skills');
    expect(starter).toContain('hf_parallel_dl');
    expect(starter).not.toContain('tools/user/');
  });

  it('tools/user/ is retired: the folder, its test and its ignore line are all gone', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'tools', 'user'))).toBe(false);
    expect(fs.readFileSync(path.join(REPO_ROOT, '.vscodeignore'), 'utf8')).not.toContain(
      '!tools/user/README.md',
    );
    expect(
      fs.existsSync(path.join(REPO_ROOT, 'test', 'unit', 'ShippedHelperScripts.test.ts')),
    ).toBe(false);
  });
});

describe('skills-lab/ (unshipped skills)', () => {
  it.skipIf(!fs.existsSync(LAB_SKILLS_ROOT))(
    'every folder parses with its name equal to the folder name',
    () => {
      for (const folder of labFolders()) {
        const manifestPath = path.join(LAB_SKILLS_ROOT, folder, 'SKILL.md');
        expect(fs.existsSync(manifestPath), `${folder}/SKILL.md missing`).toBe(true);
        const parsed = parseSkillManifest(fs.readFileSync(manifestPath, 'utf8'), folder);
        expect(parsed.ok, `${folder}: ${parsed.ok ? '' : parsed.reason}`).toBe(true);
      }
    },
  );
});
