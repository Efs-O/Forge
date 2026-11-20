/**
 * The git half of the agent note: whether the file the note would go into is a
 * file the repository commits, and the marked block in `.git/info/exclude` that
 * keeps a file Forge created out of `git status`.
 *
 * The laptop audit of 0.17.206 found Forge writing its section into `AGENTS.md`
 * and `CLAUDE.md` of every repository it opened, including the ones the
 * repository commits — so the note ended up in other people's history, in a
 * file they had to review and delete. The owner rejected a per-workspace prompt
 * (2026-01-20): the rule is that Forge never writes into a file git would
 * commit, and never asks. So the writer needs one answer per file — tracked,
 * ignored, untracked, or outside a repository — and, for a file it is about to
 * create, a way to make git ignore it that it can undo.
 *
 * `info/exclude` is that way: it is per-clone and never committed, so Forge can
 * list its own files there without touching the owner's `.gitignore`. It lives
 * under `git rev-parse --git-path info/exclude`, which is also what makes a
 * linked worktree get its own copy instead of the main checkout's. Everything
 * Forge writes sits inside one marked block, so removal takes exactly Forge's
 * lines out and leaves the rest of the file byte for byte.
 *
 * This module imports nothing that reaches `vscode`: `src/uninstall.ts` bundles
 * it without an extension host, and removal uses no git at all (the exclude
 * target is already in the registry), so an uninstall works with no git on PATH.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../util/atomicWrite';

/** Every git query gets this timeout: the note is written while the extension
 *  host activates, and a `git` that hangs must not hang the window with it. */
const GIT_TIMEOUT_MS = 10_000;

/** One line in one exclude file: the file to edit, and the pattern for the note
 *  file — `/`-prefixed and `/`-separated, relative to the repository root, which
 *  is the only spelling git's own exclude syntax accepts. */
export interface NoteExcludeTarget {
  file: string;
  line: string;
}

/**
 * What git says about one note file in one root.
 *
 * `outside-repo` means the writer may do exactly what it did before this rule
 * existed. `tracked` and `untracked` are the two files it must leave alone
 * (unless the registry proves Forge itself made the second one). `ignored` — by
 * the owner's `.gitignore`, or by Forge's own exclude line from an earlier run —
 * is a file git will never commit, so it is written as usual.
 * `{ gitFailed }` is the case the writer cannot answer for itself, and so skips.
 */
export type NoteGitClassification =
  | 'outside-repo'
  | 'tracked'
  | 'ignored'
  | 'untracked'
  | { gitFailed: string };

/** Is this classification the "git could not tell us" answer? */
export function isGitFailed(classification: NoteGitClassification): classification is {
  gitFailed: string;
} {
  return typeof classification === 'object';
}

/** Pinned whole by `test/unit/AgentNoteGit.test.ts`: the reason a file was left
 *  alone is what the log and the toast show, and it has to say what the user
 *  should do about it, not just that Forge declined. */
export const NOTE_SKIP_TRACKED =
  'tracked by git: Forge does not write its note into a file the repository commits';
export const NOTE_SKIP_UNTRACKED =
  'not ignored by git: Forge does not write its note into a file that could be committed';
export const NOTE_SKIP_IMPORT_PARENT =
  'AGENTS.md was skipped, so a CLAUDE.md importing it would carry no note';
/** The fourth skip: git is here (a `.git` entry exists) but would not answer.
 *  Naming the failure is the only way the user can tell a broken git from a
 *  missing repository. */
export function noteSkipGitUnreachable(message: string): string {
  return `inside a git repository, but git did not run (${message}): Forge cannot tell whether this file is committed`;
}

/** A git run that either produced an exit code or could not be started at all.
 *  `failed` is set only for the second: a non-zero exit is git answering. */
interface GitRun {
  status: number;
  stdout: string;
  failed?: string;
}

/** The first line of text, trimmed: what a skip reason is allowed to quote from
 *  a program's message — one line, never a stack or a help block. */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

/** Run `git -C <root> <args>` and report what it said. Never throws: the
 *  caller's answer for a git that is not there is a skip reason, not a crash
 *  during activation. */
function runGit(root: string, args: readonly string[]): GitRun {
  try {
    const stdout = execFileSync('git', ['-C', root, ...args], {
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (error) {
    const run = error as NodeJS.ErrnoException & {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    // A number is git's own exit code: it ran and answered. Anything else means
    // the process never gave one — `ENOENT` (no git on PATH) or a killed timeout.
    if (typeof run.status === 'number') {
      return { status: run.status, stdout: typeof run.stdout === 'string' ? run.stdout : '' };
    }
    const raw = run.stderr;
    const stderr = typeof raw === 'string' ? raw : (raw?.toString('utf8') ?? '');
    return {
      status: -1,
      stdout: '',
      failed: firstLine(stderr) || firstLine(run.message ?? '') || 'git did not run',
    };
  }
}

/** Output of a git query that had to succeed, or a throw: used only for the
 *  exclude target, where the writer has already been told this is a repository. */
function gitOutput(root: string, args: readonly string[]): string {
  const run = runGit(root, args);
  if (run.failed !== undefined) throw new Error(run.failed);
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} exited ${run.status}`);
  return run.stdout.trim();
}

/** Is there a `.git` entry in this folder or any ancestor? A `.git` file is a
 *  linked worktree or submodule, so both count. It is the difference between
 *  "no repository here" and "a repository whose git would not start". */
function hasGitEntry(start: string): boolean {
  let directory = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(directory, '.git'))) return true;
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

/**
 * Ask git about `<root>/<name>`: is it tracked, ignored, neither, or is this not
 * a repository at all?
 *
 * `rev-parse --show-toplevel` is the repository question, so a folder outside
 * any clone gets `outside-repo` and the writer behaves exactly as it did before
 * this rule. `ls-files --error-unmatch` is the tracked question (exit 0 is the
 * only yes: a file that does not exist simply is not tracked). `check-ignore -q`
 * is the ignore question, and its two answers are the only ones it has: exit 0
 * ignored, exit 1 not. Any other exit, like a git that would not start, is an
 * answer Forge is not allowed to guess at.
 */
export function classifyNoteTarget(root: string, name: string): NoteGitClassification {
  const top = runGit(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    if (top.failed !== undefined && hasGitEntry(root)) return { gitFailed: top.failed };
    return 'outside-repo';
  }
  const tracked = runGit(root, ['ls-files', '--error-unmatch', '--', name]);
  if (tracked.status === 0) return 'tracked';
  if (tracked.failed !== undefined) return { gitFailed: tracked.failed };
  const ignored = runGit(root, ['check-ignore', '-q', '--', name]);
  if (ignored.status === 0) return 'ignored';
  if (ignored.status === 1) return 'untracked';
  return { gitFailed: ignored.failed ?? `git check-ignore exited ${ignored.status}` };
}

/**
 * Where Forge's exclude line for `<root>/<name>` lives, and what it is.
 *
 * `--git-path info/exclude` is the whole trick for a linked worktree: it answers
 * with that worktree's own file, under `.git/worktrees/<name>/`, so the note
 * file is ignored where it was created and the main checkout is left alone.
 *
 * `--show-prefix` is git's own answer to "where is this folder inside the
 * repository", which is all a pattern like `/pkg/AGENTS.md` is asking — a
 * workspace opened at `<repo>/pkg` needs `/pkg/AGENTS.md`, not `/AGENTS.md`.
 * Computing it in Node from `--show-toplevel` is the same question answered
 * worse: a temporary folder on Windows arrives from `os.tmpdir()` in its 8.3
 * short form (`EFSOOF~1`) while git answers the long one, and two spellings of
 * one path have no common prefix to make a pattern out of. The answer is then
 * `../../../../../../../../…`, and git quietly ignores a pattern that escapes
 * the repository, which is how a note file ends up in `git status` anyway.
 */
export function excludeTarget(root: string, name: string): NoteExcludeTarget {
  const prefix = gitOutput(root, ['rev-parse', '--show-prefix']);
  const infoExclude = gitOutput(root, ['rev-parse', '--git-path', 'info/exclude']);
  return { file: path.resolve(root, infoExclude), line: `/${prefix}${name}` };
}

/** The block's two markers. The start marker says who wrote it and that it is
 *  removable, because an exclude file is the owner's and Forge may not leave a
 *  mystery in it. */
export const EXCLUDE_BLOCK_START =
  '# forge-agent-note:start (Forge removes this block when it removes its agent note)';
export const EXCLUDE_BLOCK_END = '# forge-agent-note:end';

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** The block, tolerant of the file's line endings: everything inside it is
 *  Forge's, so it may be rewritten; everything outside is matched, never touched. */
function blockMatch(content: string): RegExpExecArray | null {
  const pattern = `${escapeForRegExp(EXCLUDE_BLOCK_START)}\\r?\\n([\\s\\S]*?)\\r?\\n${escapeForRegExp(EXCLUDE_BLOCK_END)}`;
  return new RegExp(pattern, 'u').exec(content);
}

/** The line endings to write: the file's own, so a CRLF exclude file does not
 *  become a mixed file because Forge appended to it. */
function eolOf(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/** The lines inside the block, normalised: blank or whitespace-only lines and
 *  duplicates of `line` (minus `without`) are what this list exists to settle. */
function blockLines(inner: string, options: { without?: string; add?: string } = {}): string[] {
  const kept = inner
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== options.without);
  if (options.add !== undefined && !kept.includes(options.add)) kept.push(options.add);
  return kept;
}

function readExcludeFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Write the exclude file atomically, creating `info/` and the file when the
 *  clone has neither (a fresh `git init --bare`-style layout, a hand-made one). */
function writeExcludeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomicSync(file, content);
}

/**
 * Add one pattern to Forge's block at the end of an exclude file.
 *
 * The block is created when absent — after the file's existing text, with a
 * separator if that text did not end in a newline. A line already in the block
 * is left alone and the file is not rewritten at all, so a second install of
 * the same note changes nothing outside the block, byte for byte.
 */
export function addExcludeLine(target: NoteExcludeTarget): void {
  const content = readExcludeFile(target.file) ?? '';
  const eol = eolOf(content);
  const match = blockMatch(content);
  if (match === null) {
    const separator = content === '' || content.endsWith('\n') ? '' : eol;
    const block = [EXCLUDE_BLOCK_START, target.line, EXCLUDE_BLOCK_END].join(eol);
    writeExcludeFile(target.file, `${content}${separator}${block}${eol}`);
    return;
  }
  if (blockLines(match[1]).includes(target.line)) return;
  const lines = blockLines(match[1], { add: target.line });
  const rebuilt = [EXCLUDE_BLOCK_START, ...lines, EXCLUDE_BLOCK_END].join(eol);
  writeExcludeFile(
    target.file,
    content.slice(0, match.index) + rebuilt + content.slice(match.index + match[0].length),
  );
}

/**
 * Take one pattern out of Forge's block; the whole block when it is empty.
 *
 * Absent file, absent block, or a line that is not in the block: nothing is
 * written. Only the block's bytes are ever removed, plus the single newline that
 * ended it, so the file Forge left behind is the file that was there before the
 * note — including a pattern the owner wrote themselves, directly above.
 */
export function removeExcludeLine(target: NoteExcludeTarget): void {
  const content = readExcludeFile(target.file);
  if (content === undefined) return;
  const match = blockMatch(content);
  if (match === null) return;
  const inner = blockLines(match[1], { without: target.line });
  const after = content.slice(match.index + match[0].length);
  if (inner.length === 0) {
    // Drop the newline the block ended with, whatever its ending was: leaving it
    // would strand a blank line where the block used to be.
    let trailing = 0;
    if (after.startsWith('\r\n')) trailing = 2;
    else if (after.startsWith('\n') || after.startsWith('\r')) trailing = 1;
    writeExcludeFile(target.file, content.slice(0, match.index) + after.slice(trailing));
    return;
  }
  const rebuilt = [EXCLUDE_BLOCK_START, ...inner, EXCLUDE_BLOCK_END].join(eolOf(content));
  writeExcludeFile(target.file, content.slice(0, match.index) + rebuilt + after);
}

/** Is `<root>/<name>` a file already on disk? Absent is its own answer here: it
 *  is the one case where the writer is about to make the file itself. */
function isFilePresent(root: string, name: string): boolean {
  try {
    return fs.statSync(path.join(root, name)).isFile();
  } catch {
    return false;
  }
}

/**
 * May Forge write its note into `<root>/<name>`, and does the write owe an
 * exclude line?
 *
 * A tracked file is in someone else's history the moment Forge writes it, so it
 * is left alone. An untracked file Forge did not create is the owner's, and one
 * `git add` away from being committed, so it is left alone too. An untracked
 * file the registry says Forge created — one an older Forge wrote before this
 * rule existed — is Forge's to keep, and it gets the exclude line first. A file
 * git ignores (by the owner's `.gitignore`, or by Forge's own line from an
 * earlier run) can never be committed, so it is written as before. Outside a
 * repository nothing changed: the same write as always.
 *
 * `wasCreated` is the one question this module cannot answer for itself — the
 * registry lives in `agentNoteRemoval.ts`, which imports this one — and it is
 * asked with the path Forge would write, resolved the way the registry stores it.
 *
 * `gitUnreachable` marks the one answer that is not a refusal but an unknown:
 * when git would not start, nothing about this file's result says anything about
 * the other note file, so the caller asks git about that one too.
 */
export function decideNoteWrite(
  root: string,
  name: string,
  wasCreated: (filePath: string) => boolean,
):
  | { write: true; exclude?: NoteExcludeTarget }
  | { write: false; reason: string; gitUnreachable?: boolean } {
  const classification = classifyNoteTarget(root, name);
  if (isGitFailed(classification))
    return {
      write: false,
      reason: noteSkipGitUnreachable(classification.gitFailed),
      gitUnreachable: true,
    };
  if (classification === 'tracked') return { write: false, reason: NOTE_SKIP_TRACKED };
  if (classification === 'ignored' || classification === 'outside-repo') return { write: true };
  // Absent means Forge is about to create the file, so it is Forge's file by
  // definition — and the exclude line is what keeps it out of `git status`.
  if (!isFilePresent(root, name)) return { write: true, exclude: excludeTarget(root, name) };
  if (!wasCreated(path.resolve(root, name))) return { write: false, reason: NOTE_SKIP_UNTRACKED };
  return { write: true, exclude: excludeTarget(root, name) };
}
