/**
 * Reading one skill out for `load_skill` (plan §2.3).
 *
 * The tool result is the `SKILL.md` body — not its frontmatter, which the
 * catalog already showed — plus the real paths of everything under `scripts/`
 * and `references/`. Paths are real because the plan says so: a symlinked script
 * that resolves outside its skill folder is not that skill's script, and handing
 * the model a link path would let a workspace skill point its "script" at any
 * file on the machine and call it part of the skill.
 *
 * `config.json` is deliberately not read here. It is the skill's own settings —
 * this PC's paths and ports — and its scripts read it themselves; returning it
 * would put a machine-specific blob into every conversation that loads a skill,
 * and a key inside it would land in the prompt of a model that cannot use it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isInsideRealPath, sameRealPath } from './paths';
import { parseSkillManifest, type SkillEntry } from './discover';

export interface LoadedSkill {
  entry: SkillEntry;
  /** The SKILL.md body, frontmatter excluded. */
  body: string;
  /** Real absolute paths under `scripts/`, sub-folders included. */
  scripts: string[];
  /** Real absolute paths under `references/`. */
  references: string[];
  /** Entries whose real path leaves the skill folder, named but not offered. */
  escaped: string[];
  /** True when the folder holds a `config.json` (its contents are never read). */
  hasConfigJson: boolean;
  /** Set when the skill could not be read — discovery saw it, this read did not. */
  readError?: string;
}

/** Bounds on the walk: a symlink loop or a vendored folder must not hang a call. */
const MAX_WALK_DEPTH = 4;
const MAX_WALKED_FILES = 200;

interface Walked {
  files: string[];
  escaped: string[];
}

/** One folder, walked to a bounded depth; every path returned is already resolved. */
function walk(root: string, directory: string, depth: number, out: Walked): void {
  if (out.files.length >= MAX_WALKED_FILES) return;
  let names: string[];
  try {
    names = fs.readdirSync(directory).sort();
  } catch {
    return; // no scripts/ or references/ folder: nothing to say
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (out.files.length >= MAX_WALKED_FILES) return;
    let real: string;
    try {
      real = fs.realpathSync(path.join(directory, name));
    } catch {
      continue; // a broken link runs nothing; saying so is not worth a line
    }
    if (!isInsideRealPath(root, real)) {
      out.escaped.push(name);
      continue;
    }
    let isDirectory: boolean;
    try {
      isDirectory = fs.statSync(real).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) {
      if (depth < MAX_WALK_DEPTH) walk(root, real, depth + 1, out);
      continue;
    }
    out.files.push(real);
  }
}

/**
 * Resolve one skill again before reading it, or say why it cannot be read.
 *
 * Discovery proved `SKILL.md` sits inside its folder, but that proof and this
 * read are not the same moment: the catalog is frozen for a conversation and
 * `load_skill` runs on a later turn, so in between the file can be replaced with
 * a link pointing out of the folder. `load_skill` is auto-approved, so whatever
 * this read returns goes into the transcript with no approval card, which means
 * the containment has to be re-established at the moment of reading, from paths
 * resolved then, not assumed from a walk done earlier.
 *
 * Three things are checked, in the order discovery checked them: the folder is
 * still there, it is still strictly below the skills root it was catalogued
 * under (`entry.linkPath`'s parent, which the entry already carries, so no new
 * field is needed), and `SKILL.md` is still inside the folder. The resolved
 * folder comes back as the boundary for everything under it, so the script walk
 * gets a path resolved now rather than the one discovery left behind.
 */
function locateSkill(
  entry: SkillEntry,
): { ok: true; folder: string; manifest: string } | { ok: false; reason: string } {
  const rootDirectory = path.dirname(entry.linkPath);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(rootDirectory);
  } catch {
    return {
      ok: false,
      reason: `the skills root \`${rootDirectory}\` is gone, so this skill is not where the catalog said it was`,
    };
  }
  let folder: string;
  try {
    folder = fs.realpathSync(entry.folderPath);
  } catch {
    return { ok: false, reason: 'the skill folder is gone' };
  }
  if (sameRealPath(realRoot, folder)) {
    return {
      ok: false,
      reason: 'it is the skills root itself, not a skill folder inside the root',
    };
  }
  if (!isInsideRealPath(realRoot, folder)) {
    return {
      ok: false,
      reason: 'the skill folder now resolves outside the skills root it was catalogued under',
    };
  }
  let manifest: string;
  try {
    manifest = fs.realpathSync(path.join(folder, 'SKILL.md'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: `SKILL.md could not be read (${code ?? String(error)})` };
  }
  if (!isInsideRealPath(folder, manifest)) {
    return {
      ok: false,
      reason:
        "SKILL.md now points outside the skill folder, so it was not read: a skill's " +
        'instructions have to come from inside its own folder, and this one is a link ' +
        'to somewhere else',
    };
  }
  try {
    if (!fs.statSync(manifest).isFile()) {
      return { ok: false, reason: 'SKILL.md is not a file, so there is nothing to read' };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: `SKILL.md could not be read (${code ?? String(error)})` };
  }
  return { ok: true, folder, manifest };
}

/** Read one skill's body and file list. Nothing is cached: a re-load must see the edit. */
export async function loadSkill(entry: SkillEntry): Promise<LoadedSkill> {
  const located = locateSkill(entry);
  if (!located.ok) {
    // Nothing about this folder can be trusted once its containment fails, so
    // nothing is listed beside the reason: half a skill, read after it escaped,
    // is worse than none, because the model would run a script it cannot see.
    return {
      entry,
      body: '',
      scripts: [],
      references: [],
      escaped: [],
      hasConfigJson: false,
      readError: located.reason,
    };
  }
  const root = located.folder;
  const scripts: Walked = { files: [], escaped: [] };
  const references: Walked = { files: [], escaped: [] };
  let content: string | undefined;
  let readError: string | undefined;
  try {
    content = fs.readFileSync(located.manifest, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    readError = `SKILL.md could not be read (${code ?? String(error)})`;
  }
  for (const [sub, out] of [
    ['scripts', scripts],
    ['references', references],
  ] as const) {
    try {
      const realSub = fs.realpathSync(path.join(root, sub));
      if (fs.statSync(realSub).isDirectory() && isInsideRealPath(root, realSub)) {
        walk(root, realSub, 1, out);
      }
    } catch {
      // The folder is optional; its absence says nothing.
    }
  }
  let hasConfigJson = false;
  try {
    hasConfigJson = fs.statSync(path.join(root, 'config.json')).isFile();
  } catch {
    hasConfigJson = false;
  }

  if (content === undefined) {
    return {
      entry,
      body: '',
      scripts: scripts.files,
      references: references.files,
      escaped: [...scripts.escaped, ...references.escaped],
      hasConfigJson,
      readError: readError ?? 'SKILL.md could not be read',
    };
  }
  const parsed = parseSkillManifest(content, entry.name);
  if (!parsed.ok) {
    return {
      entry,
      body: '',
      scripts: scripts.files,
      references: references.files,
      escaped: [...scripts.escaped, ...references.escaped],
      hasConfigJson,
      readError: `its SKILL.md no longer parses: ${parsed.reason}`,
    };
  }
  return {
    entry,
    body: content.slice(parsed.bodyStart).trim(),
    scripts: scripts.files,
    references: references.files,
    escaped: [...scripts.escaped, ...references.escaped],
    hasConfigJson,
  };
}
