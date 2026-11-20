/**
 * Which files Forge wrote the agent note into, and how they get it back out.
 *
 * The note in a workspace's `AGENTS.md` / `CLAUDE.md` and the user-wide copy in
 * `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` are instructions to a coding
 * agent. Left behind they read as standing instructions from a program that is
 * gone: an agent follows `forge.sh`, waits on an answer that never comes, or
 * reports a bridge that no longer exists. So Forge removes its sections in two
 * situations an install cannot leave to the owner:
 *
 * - the mesh is switched off (`agent_bus: { enabled: false }`) — the note tells
 *   agents to message chats that no longer listen;
 * - Forge is uninstalled — `vscode:uninstall` runs this module's
 *   `removeRecordedAgentNotes` through `src/uninstall.ts`.
 *
 * The user-wide copy can only be removed on uninstall: another workspace on the
 * machine may still have its mesh on, and that workspace's start is the only
 * thing that knows.
 *
 * Removal needs to know which files Forge wrote, because "delete the file" is
 * only safe when nothing else is in it and Forge is the one who put it there.
 * `note-files.json` under `~/.forge/agent-bus` records that, one entry per file,
 * written after every install or refresh. It is a convenience, not a promise:
 * a file Forge wrote before the registry existed is still cleaned up (its
 * section goes, its content stays), and a torn registry costs one missed
 * deletion rather than breaking anything.
 *
 * This module deliberately imports nothing that reaches `vscode`: the uninstall
 * script runs after the extension is gone, with no extension host to ask.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AGENTS_MD_IMPORT_FILE_CONTENT,
  AGENT_INSTRUCTION_FILE_NAMES,
  removeAgentMeshSections,
} from './agentMeshNote';
import { removeExcludeLine, type NoteExcludeTarget } from './agentNoteGit';
import { writeFileAtomicSync } from '../util/atomicWrite';

/** One recorded file: where it is, whether Forge created it, and — when Forge
 *  made git ignore it — the exclude line to take back out with it. */
export interface NoteFileRecord {
  path: string;
  created: boolean;
  exclude?: NoteExcludeTarget;
}

const REGISTRY_VERSION = 1;

/** Where the registry lives. `home` is a parameter rather than `os.homedir()` so
 *  a test can point the whole feature at a temporary folder — and so a test that
 *  reached the real home is visible instead of quietly editing the owner's file. */
export function noteFilesRegistryPath(home: string = os.homedir()): string {
  return path.join(home, '.forge', 'agent-bus', 'note-files.json');
}

function registryText(files: readonly NoteFileRecord[]): string {
  return `${JSON.stringify({ version: REGISTRY_VERSION, files }, null, 2)}\n`;
}

/** Parse the registry, or say it is no registry at all. A torn file (a crash
 *  between the temp write and the rename, a hand edit) reads as empty: the next
 *  install rebuilds it, and the cost is one file left undeleted. */
function parseRegistry(raw: string): NoteFileRecord[] | undefined {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; files?: unknown };
    if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.files)) return undefined;
    const files: NoteFileRecord[] = [];
    for (const entry of parsed.files) {
      const record = entry as {
        path?: unknown;
        created?: unknown;
        exclude?: { file?: unknown; line?: unknown } | null;
      };
      if (typeof record.path !== 'string' || typeof record.created !== 'boolean') return undefined;
      if (record.exclude === undefined || record.exclude === null) {
        files.push({ path: record.path, created: record.created });
        continue;
      }
      // A half-written `exclude` is as much a foreign shape as a half-written
      // `created`: the whole file is unreadable, and the next install rebuilds it.
      const { file, line } = record.exclude;
      if (typeof file !== 'string' || typeof line !== 'string') return undefined;
      files.push({ path: record.path, created: record.created, exclude: { file, line } });
    }
    return files;
  } catch {
    return undefined;
  }
}

/** The recorded files, or none: a missing file, invalid JSON or a shape this
 *  build does not recognise all read as an empty registry. */
export function readNoteFiles(registryPath: string): NoteFileRecord[] {
  try {
    return parseRegistry(fs.readFileSync(registryPath, 'utf8')) ?? [];
  } catch {
    return [];
  }
}

/** The statuses that mean "a section or an import file of ours is in there".
 *  `skipped` (a symlink, a file that appeared under us) and `error` say nothing
 *  Forge would act on, so they are not recorded. */
const RECORDED_STATUSES = new Set(['created', 'appended', 'replaced', 'unchanged']);

/**
 * Add this install's files to the registry.
 *
 * `created` is what a later removal is allowed to act on, and it is only ever
 * set by the run that made the file: a later `appended`/`replaced`/`unchanged`
 * for the same path keeps the `created: true` already recorded, so an
 * `AGENTS.md` Forge created is still deletable after a refresh touched it. The
 * same holds for `exclude`: a run that did not need to write the line (because
 * git already ignores the file) keeps the line the earlier run recorded, so
 * there is always exactly one owner of the pattern to take it out again.
 */
export function recordNoteFiles(
  registryPath: string,
  results: readonly { path: string; status: string; exclude?: NoteExcludeTarget }[],
): void {
  const existing = readNoteFiles(registryPath);
  const byPath = new Map(existing.map((record) => [record.path, record]));
  for (const result of results) {
    if (!RECORDED_STATUSES.has(result.status)) continue;
    const filePath = path.resolve(result.path);
    const previous = byPath.get(filePath);
    const created = previous?.created === true || result.status === 'created';
    const exclude = result.exclude ?? previous?.exclude;
    byPath.set(
      filePath,
      exclude ? { path: filePath, created, exclude } : { path: filePath, created },
    );
  }
  const files = [...byPath.values()].sort((left, right) =>
    left.path === right.path ? 0 : left.path < right.path ? -1 : 1,
  );
  const before = existing
    .slice()
    .sort((left, right) => (left.path === right.path ? 0 : left.path < right.path ? -1 : 1));
  if (JSON.stringify(before) === JSON.stringify(files)) return;
  try {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileAtomicSync(registryPath, registryText(files));
  } catch {
    // A registry Forge could not write costs one file left undeleted later; it
    // is not a reason to fail the note write that just succeeded.
  }
}

/** What removing the note from one file did. */
export type NoteRemovalStatus = 'removed' | 'deleted' | 'none' | 'skipped' | 'error';

export interface NoteRemovalResult {
  path: string;
  status: NoteRemovalStatus;
  reason?: string;
}

/**
 * Take Forge's section out of one file.
 *
 * Deleting is the narrow case: only a file Forge created, holding nothing but
 * Forge's text, goes away. Everything else is a rewrite of the same file, and a
 * file that never had a marker is not opened for writing at all.
 */
export function removeNoteFromFile(filePath: string, created: boolean): NoteRemovalResult {
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      // A link or a folder named AGENTS.md may hold no note at all, and the
      // mesh-off start warns on every `skipped`: read through it first, so only
      // a note behind the link is worth warning about. Nothing is written here.
      let linked: string;
      try {
        linked = fs.readFileSync(filePath, 'utf8');
      } catch {
        // A folder, a junction, a dangling link: no content, so no note.
        return { path: filePath, status: 'none' };
      }
      if (removeAgentMeshSections(linked).status === 'none')
        return { path: filePath, status: 'none' };
      return { path: filePath, status: 'skipped', reason: 'not a regular file' };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    if (created && content === AGENTS_MD_IMPORT_FILE_CONTENT) {
      // A `CLAUDE.md` Forge created holds nothing but the `@AGENTS.md` line.
      fs.unlinkSync(filePath);
      return { path: filePath, status: 'deleted' };
    }
    const removal = removeAgentMeshSections(content);
    if (removal.status === 'none') return { path: filePath, status: 'none' };
    if (removal.status === 'lone-marker') {
      return {
        path: filePath,
        status: 'skipped',
        reason: 'a lone forge-agent-mesh marker; left as it is',
      };
    }
    if (created && removal.content.trim() === '') {
      fs.unlinkSync(filePath);
      return { path: filePath, status: 'deleted' };
    }
    writeFileAtomicSync(filePath, removal.content);
    return { path: filePath, status: 'removed' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { path: filePath, status: 'none' };
    return { path: filePath, status: 'error', reason: (error as Error).message };
  }
}

/** Outcomes that mean the registry entry is spent, whether or not the file went. */
const SPENT_STATUSES = new Set<NoteRemovalStatus>(['removed', 'deleted', 'none']);

/** Rewrite the registry with `kept`, or remove the file when nothing is kept. */
function rewriteRegistry(registryPath: string, kept: readonly NoteFileRecord[]): void {
  try {
    if (!kept.length) {
      fs.rmSync(registryPath, { force: true });
      return;
    }
    writeFileAtomicSync(registryPath, registryText(kept));
  } catch {
    // A registry left behind by a failed cleanup names files Forge already
    // tried; the removals themselves have all happened by now.
  }
}

/** The registry entries still worth remembering, once `results` are spent. */
function remainingRecords(
  records: readonly NoteFileRecord[],
  results: readonly NoteRemovalResult[],
): NoteFileRecord[] {
  const statuses = new Map(results.map((result) => [result.path, result.status] as const));
  return records.filter(
    (record) => !SPENT_STATUSES.has(statuses.get(record.path) as NoteRemovalStatus),
  );
}

/**
 * Take Forge's exclude line out of the exclude file for every record this run
 * spent, and report a failure to do so on the note result it belongs to.
 *
 * No git is asked: the pattern and the file it lives in were recorded when the
 * line was written, so an uninstall cleans up after itself even with no git on
 * PATH. A leftover line is not worth failing the uninstall for — the note, which
 * is the part agents read, is already gone — but it is named, because an exclude
 * file the owner opens should not hold a mystery. This never throws.
 */
function withExcludeRemovals(
  results: readonly NoteRemovalResult[],
  records: readonly NoteFileRecord[],
): NoteRemovalResult[] {
  const excludes = new Map<string, NoteExcludeTarget>();
  for (const record of records) if (record.exclude) excludes.set(record.path, record.exclude);
  return results.map((result) => {
    const exclude = SPENT_STATUSES.has(result.status) ? excludes.get(result.path) : undefined;
    if (exclude === undefined) return result;
    try {
      removeExcludeLine(exclude);
    } catch (error) {
      return { ...result, reason: `exclude: ${(error as Error).message}` };
    }
    return result;
  });
}

/**
 * Remove Forge's section from the instruction files of these workspace roots.
 *
 * `created` comes from the registry, so an unrecorded file — one written by an
 * older Forge that had no registry, or by another tool entirely — loses its
 * section but keeps its file. A file that is not here is a `none`, which is just
 * as spent: the workspace is clean either way.
 */
export function removeWorkspaceAgentNotes(
  roots: readonly string[],
  registryPath: string,
): NoteRemovalResult[] {
  const records = readNoteFiles(registryPath);
  const createdByPath = new Map(records.map((record) => [record.path, record.created]));
  const results = withExcludeRemovals(
    roots.flatMap((root) =>
      AGENT_INSTRUCTION_FILE_NAMES.map((name) => {
        const filePath = path.resolve(root, name);
        return removeNoteFromFile(filePath, createdByPath.get(filePath) === true);
      }),
    ),
    records,
  );
  rewriteRegistry(registryPath, remainingRecords(records, results));
  return results;
}

/**
 * Remove Forge's section from every file the registry names — the uninstall
 * path, which is the only one that reaches the user-wide copies.
 *
 * A file Forge could not touch (a symlink, a permission it was not given) stays
 * in the registry with its reason, so the next uninstall — or a human reading
 * the file — can see what is still outstanding.
 */
export function removeRecordedAgentNotes(registryPath: string): NoteRemovalResult[] {
  const records = readNoteFiles(registryPath);
  const results = withExcludeRemovals(
    records.map((record) => removeNoteFromFile(record.path, record.created)),
    records,
  );
  rewriteRegistry(registryPath, remainingRecords(records, results));
  return results;
}
