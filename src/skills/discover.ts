/**
 * Skill discovery (TOOLS_EXPANSION_PLAN.md Part 2.1–2.2, lane F2).
 *
 * A skill is a folder with a `SKILL.md` whose frontmatter names it, plus tested
 * scripts the model runs through `shell`. The format is the one Claude Code and
 * Codex use, so a skill written for Forge works in them unchanged.
 *
 * Three roots are scanned, and a later one wins over an earlier one by name —
 * shipped, then the owner's `~/.forge/skills/`, then the open workspace's
 * `.forge/skills/`. That order is the whole shadowing rule, and the winner
 * carries a note naming what it shadowed so the catalog can say it out loud:
 * a workspace skill comes from whatever repo is open, so a user must be able to
 * see that the line they are reading came from the repo, not from Forge.
 *
 * Two rules here are load-bearing for trust (audit finding 3):
 * - a broken skill is skipped WITH a reason while its neighbours still load, so
 *   one half-written `SKILL.md` cannot take the catalog down (the ledger's
 *   "Crash mid-write" cell);
 * - symlinks are resolved before anything is read, and a file whose real path
 *   leaves its skill folder is skipped, so a link cannot smuggle instructions in
 *   from outside the folder — the same containment `ForgeInstructionsLoader.ts`
 *   applies to a symlinked `FORGE.md`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isInsideRealPath, sameRealPath } from './paths';

export type SkillRootKind = 'shipped' | 'user' | 'workspace';

/** The label each root gets in the catalog line, per plan §2.3. */
export const SKILL_ROOT_LABELS: Record<SkillRootKind, string> = {
  shipped: 'shipped',
  user: 'user',
  workspace: 'workspace',
};

export interface SkillRoot {
  kind: SkillRootKind;
  directory: string;
}

export interface SkillEntry {
  name: string;
  /** The one-line `description` from the frontmatter, shown in the catalog. */
  description: string;
  root: SkillRootKind;
  /** The folder as it was found, before symlink resolution. */
  linkPath: string;
  /** The resolved folder; every path handed to the model comes from here. */
  folderPath: string;
  /** Set on a skill that took a name an earlier root also had. */
  shadowNote?: string;
}

export interface SkillSkip {
  /** The folder name as found, which is what the owner can go and look at. */
  name: string;
  root: SkillRootKind;
  directory: string;
  reason: string;
}

export interface DiscoveredSkills {
  /** Alphabetical: the catalog order a user reads. */
  skills: SkillEntry[];
  /** Every folder that was found and not loaded, in scan order. */
  skipped: SkillSkip[];
}

export type ParsedManifest =
  | { ok: true; name: string; description: string; bodyStart: number }
  | { ok: false; reason: string };

/** The most characters of a description the catalog line will carry. */
export const MAX_SKILL_DESCRIPTION_CHARS = 240;

/** A skill name that is one folder-safe word, as Claude Code and Codex require. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function truncateDescription(value: string): string {
  if (value.length <= MAX_SKILL_DESCRIPTION_CHARS) return value;
  return `${value.slice(0, MAX_SKILL_DESCRIPTION_CHARS - 1)}…`;
}

// Both containment questions come from `paths.ts`, their one owner: a second
// spelling inside this file is how one half drifts from the other while both
// still read right. Where discovery needs "strictly below" rather than "inside",
// it says so by putting `sameRealPath` beside `isInsideRealPath` instead of
// growing a variant that only this file uses.

/**
 * Parse one `SKILL.md` against the folder it lives in.
 *
 * `name` must equal the folder name: the name is how the model asks for the
 * skill, and a manifest that names a different folder is a copy-paste that would
 * otherwise make two skills answer to one name. `description` must be one line
 * because the catalog is one line per skill — a wrapped description is refused
 * rather than silently joined, so the author learns the rule now instead of
 * watching their skill disappear from a 4,000-character catalog.
 *
 * It does not know the roots and does not touch the filesystem: the shipped
 * folder test and the loader both call this one parser, so they cannot drift.
 */
export function parseSkillManifest(content: string, expectedFolderName: string): ParsedManifest {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  if (lines[0]?.trim() !== '---') {
    return { ok: false, reason: 'SKILL.md must start with a `---` frontmatter fence' };
  }
  const values = new Map<string, string>();
  let closeIndex = -1;
  // The key the previous line declared, so a wrapped value can be told apart from
  // a malformed line: `description:` followed by prose is the one frontmatter
  // mistake whose fix is a rule the author needs told, not a syntax note.
  let lastKey = '';
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '---') {
      closeIndex = index;
      break;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/u.exec(line);
    if (!match) {
      return lastKey === 'description'
        ? {
            ok: false,
            reason:
              'the `description` spans more than one line — write the rest of the workflow ' +
              'into the body; the catalog is one line per skill',
          }
        : {
            ok: false,
            reason: `frontmatter line ${String(index + 1)} is not \`key: value\`: ${line.slice(0, 60)}`,
          };
    }
    const key = match[1]!.toLowerCase();
    if (values.has(key)) return { ok: false, reason: `duplicate \`${key}\` in the frontmatter` };
    values.set(key, match[2]!.trim());
    lastKey = key;
  }
  if (closeIndex === -1) return { ok: false, reason: 'the `---` frontmatter fence is not closed' };

  const name = values.get('name') ?? '';
  if (!name) return { ok: false, reason: 'the frontmatter has no `name:`' };
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, reason: `\`${name}\` is not a single folder-safe skill name` };
  }
  // `paths.ts` owns this comparison. Both sides are single folder names
  // (`NAME_PATTERN` above rules out anything path-shaped), so the rule that
  // governs folder names on this filesystem — case-insensitive on Windows,
  // exact elsewhere — governs this one too, and there is no second spelling of
  // it here to drift from the one the walk uses.
  if (!sameRealPath(name, expectedFolderName)) {
    return {
      ok: false,
      reason:
        `name \`${name}\` must equal the folder name \`${expectedFolderName}\` ` +
        '(the name is how the model asks for this skill)',
    };
  }
  const description = values.get('description') ?? '';
  if (!description) return { ok: false, reason: 'the frontmatter has no `description:`' };
  return {
    ok: true,
    name,
    description: truncateDescription(description),
    bodyStart: offsetAfterLines(content, closeIndex + 1),
  };
}

/**
 * The character offset just past the first `lineCount` newlines of `content`.
 *
 * Counted against the original text, not against a `\n`-normalised copy: the
 * body is what the author wrote, CRLF included, and an offset computed on a
 * copy would land mid-line on every Windows-written SKILL.md.
 */
function offsetAfterLines(content: string, lineCount: number): number {
  let offset = 0;
  for (let index = 0; index < lineCount; index += 1) {
    const next = content.indexOf('\n', offset);
    if (next === -1) return content.length;
    offset = next + 1;
  }
  return offset;
}

export interface SkillRootOptions {
  /** The extension install folder; its `resources/skills/` is the shipped root. */
  extensionPath: string;
  home: string;
  workspaceRoot?: string;
  /** Test seams: a root other than the default for its kind. */
  userSkillsDirectory?: string;
  workspaceSkillsDirectory?: string;
}

/**
 * The three roots, in the order later ones win.
 *
 * A workspace with no `.forge/skills/` contributes no workspace root at all:
 * the plan says skills live in three places, and pretending an empty fourth
 * thing exists would only make the catalog's provenance labels harder to read.
 */
export function skillRoots(options: SkillRootOptions): SkillRoot[] {
  const roots: SkillRoot[] = [
    { kind: 'shipped', directory: path.join(options.extensionPath, 'resources', 'skills') },
    {
      kind: 'user',
      directory: options.userSkillsDirectory ?? path.join(options.home, '.forge', 'skills'),
    },
  ];
  const workspaceSkills = options.workspaceSkillsDirectory
    ? options.workspaceSkillsDirectory
    : options.workspaceRoot
      ? path.join(options.workspaceRoot, '.forge', 'skills')
      : '';
  if (workspaceSkills && fs.existsSync(workspaceSkills)) {
    roots.push({ kind: 'workspace', directory: workspaceSkills });
  }
  return roots;
}

/**
 * Walk the roots and read every skill, skipping what cannot be read.
 *
 * Roots are visited in order and the last root to name a skill wins; the winner
 * records the roots it displaced. A folder that is a symlink is resolved first,
 * so the name rule, the containment rule and the paths the model finally gets
 * all see the real folder — a link is a way of storing a skill in two places,
 * not a way of escaping the rules.
 */
export function discoverSkills(roots: readonly SkillRoot[]): DiscoveredSkills {
  const byName = new Map<string, SkillEntry>();
  const displaced = new Map<string, SkillEntry[]>();
  const skipped: SkillSkip[] = [];
  const skip = (name: string, root: SkillRoot, directory: string, reason: string): void => {
    skipped.push({ name, root: root.kind, directory, reason });
  };

  for (const root of roots) {
    let names: string[];
    // The root path itself can run through a junction or a symlink —
    // `~/.forge/skills` moved to another drive, or a workspace opened through a
    // link — and then every folder under it realpaths to a different prefix than
    // the unresolved root, so every one of them would be skipped as "outside" and
    // the whole root would disappear without a skill being reported. Resolve the
    // root once here and compare against the resolved path.
    let realRoot: string;
    try {
      if (!fs.statSync(root.directory).isDirectory()) continue;
      realRoot = fs.realpathSync(root.directory);
      names = fs.readdirSync(root.directory).sort();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Absent is the ordinary case for a root nobody has filled in yet; saying
      // so once per conversation would be noise. Anything else is a fact.
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EPERM') {
        skip(
          '(root)',
          root,
          root.directory,
          `the root could not be read: ${code ?? String(error)}`,
        );
      }
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const linkPath = path.join(root.directory, name);
      let realFolder: string;
      try {
        realFolder = fs.realpathSync(linkPath);
      } catch {
        skip(name, root, linkPath, 'the entry could not be resolved');
        continue;
      }
      // Strictly below the root, not "same path or below": a link that points at
      // the root itself is not a skill folder inside it, and counting it as one
      // would let a single folder stand for every skill in the root.
      if (sameRealPath(realRoot, realFolder)) {
        skip(name, root, linkPath, 'is the skills root itself, not a skill folder inside the root');
        continue;
      }
      if (!isInsideRealPath(realRoot, realFolder)) {
        skip(name, root, linkPath, 'resolves outside this skill root');
        continue;
      }
      let folderReal: boolean;
      try {
        folderReal = fs.statSync(realFolder).isDirectory();
      } catch {
        folderReal = false;
      }
      if (!folderReal) {
        skip(name, root, linkPath, 'not a folder (a skill is a folder with a SKILL.md inside it)');
        continue;
      }
      const manifestPath = path.join(realFolder, 'SKILL.md');
      let content: string;
      try {
        const realManifest = fs.realpathSync(manifestPath);
        if (!isInsideRealPath(realFolder, realManifest)) {
          skip(
            name,
            root,
            linkPath,
            "SKILL.md resolves outside the skill folder, so its instructions are not this folder's",
          );
          continue;
        }
        if (!fs.statSync(realManifest).isFile()) {
          skip(name, root, linkPath, 'SKILL.md is not a file');
          continue;
        }
        content = fs.readFileSync(realManifest, 'utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          skip(name, root, linkPath, 'no SKILL.md inside it');
        } else {
          skip(name, root, linkPath, `SKILL.md could not be read: ${code ?? String(error)}`);
        }
        continue;
      }
      const parsed = parseSkillManifest(content, name);
      if (!parsed.ok) {
        skip(name, root, linkPath, parsed.reason);
        continue;
      }
      const entry: SkillEntry = {
        name: parsed.name,
        description: parsed.description,
        root: root.kind,
        linkPath,
        folderPath: realFolder,
      };
      const winner = byName.get(entry.name);
      if (winner) {
        // Later root wins; the winner names what it displaced, in root order.
        const chain = [winner, ...(displaced.get(winner.name) ?? [])];
        displaced.set(entry.name, chain);
        entry.shadowNote = `shadows the ${chain
          .map((earlier) => `[${SKILL_ROOT_LABELS[earlier.root]}]`)
          .join(' and ')} skill${chain.length > 1 ? 's' : ''} of the same name`;
        byName.set(entry.name, entry);
      } else {
        byName.set(entry.name, entry);
      }
    }
  }

  return {
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    skipped,
  };
}
