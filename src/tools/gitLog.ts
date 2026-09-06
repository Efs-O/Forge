/**
 * `git log` argument construction and output framing.
 *
 * `git_log` used to go through the VS Code Git extension's `repo.log()`, which
 * meant the tool did nothing at all in a workspace where that extension was
 * unavailable while `git_status` beside it worked. Running git directly needs
 * two things the extension gave for free, so they live here rather than inline
 * in the tool: argument validation, and a record framing that cannot be
 * confused by commit message content.
 */

const MAX_ENTRIES_LIMIT = 500;

/**
 * Fields are newline-separated and commits are NUL-separated (`-z`).
 *
 * The obvious alternative — a control character such as `\x1f` between fields —
 * is not safe: nothing stops a commit message containing one. Here the three
 * fixed fields (hash, author name, author date) cannot themselves contain a
 * newline, and the free-form body is last, so the first three lines of a record
 * are unambiguous no matter what the message holds. NUL cannot appear in a
 * commit object, so the record boundary is unambiguous too.
 */
const FORMAT = '--format=%H%n%an%n%aI%n%B';

export interface GitLogEntry {
  hash: string;
  authorName: string;
  /** Author date, ISO-8601, exactly as git printed it. */
  authorDate: string;
  /** Full commit body, unnormalised. */
  message: string;
}

export function gitLogArgs(maxEntries: number, ref?: string): string[] {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES_LIMIT) {
    throw new Error(
      `git_log: max_entries must be an integer between 1 and ${MAX_ENTRIES_LIMIT} (got ${String(maxEntries)})`,
    );
  }
  const args = ['log', `--max-count=${maxEntries}`, FORMAT, '-z'];
  if (ref !== undefined) {
    if (ref.startsWith('-')) {
      throw new Error(`git_log: branch "${ref}" is not a valid ref (it looks like an option)`);
    }
    if (ref === '' || /[\0\n\r]/.test(ref)) {
      throw new Error('git_log: branch must be a non-empty ref without control characters');
    }
    args.push(ref);
  }
  // Everything before `--` is a revision. Without it, a ref that is also a
  // filename would be read as a pathspec and silently log the wrong thing.
  args.push('--');
  return args;
}

export function parseGitLog(stdout: string): GitLogEntry[] {
  return stdout
    .split('\0')
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const lines = record.replace(/^\n+/, '').split('\n');
      return {
        hash: lines[0] ?? '',
        authorName: lines[1] ?? '',
        authorDate: lines[2] ?? '',
        message: lines.slice(3).join('\n'),
      };
    })
    .filter((entry) => entry.hash !== '');
}

export function formatGitLog(stdout: string): string {
  const entries = parseGitLog(stdout);
  if (!entries.length) return 'No commits.';
  return entries
    .map((entry) => {
      const shortHash = entry.hash.slice(0, 7);
      // The first line of the raw body, matching what this tool has always
      // shown. `%s` would be a differently normalised subject.
      const firstLine = entry.message.split('\n')[0] ?? '';
      const date = entry.authorDate.slice(0, 10);
      return `${shortHash} — ${firstLine} (${entry.authorName}, ${date})`;
    })
    .join('\n');
}

/**
 * A repository with no commits yet is an empty log, not a tool failure.
 *
 * Deliberately narrow: an unknown *explicit* ref must still surface as an
 * error, so "unknown revision" is not matched here — reporting "No commits."
 * for a typo'd branch name would be a tool that lies.
 */
export function isEmptyHistoryError(message: string): boolean {
  return /does not have any commits yet|bad default revision/i.test(message);
}
