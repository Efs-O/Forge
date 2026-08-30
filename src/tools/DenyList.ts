/**
 * Platform-aware command denylist.
 * Checked before any exec_command or run_terminal dispatch.
 */

export interface DenyListEntry {
  /** Matched against the whole command line. Omit when `match` is supplied. */
  pattern?: RegExp;
  /**
   * Precise predicate for rules a regex cannot express safely.
   *
   * A denylist that refuses the wrong thing is not "extra safe" — it teaches the
   * agent that a legitimate command is forbidden, and it goes looking for a way
   * around the block. Rules that need to reason about flags belong here.
   */
  match?: (fullCommand: string) => boolean;
  description: string;
  /** Appended to the refusal so the agent is told what to do instead. */
  alternative?: string;
}

/** Command words that may precede a subcommand, e.g. `sudo rm`, `git rm`. */
const COMMAND_PREFIXES = new Set(['sudo', 'git', 'npx', 'pnpm', 'yarn', 'npm', 'run', 'exec']);

/**
 * True when the command line is a recursive *and* forced delete.
 *
 * Replaces `/\brm\b.*-[rR].*-?[fF]/`, whose trailing `-?[fF]` made the hyphen
 * optional — so any bare "r" in a later filename satisfied it. Measured:
 * `git rm -f README.md` was refused (the "r" in README) while
 * `git rm -f notes.txt` was allowed. The agent needed the former to clean up
 * five temp files it had created, and the refusal read as policy rather than as
 * the accident it was.
 *
 * Recursion and force must BOTH be present, as real flags — combined (`-rf`),
 * separate (`-r -f`), or long (`--recursive --force`).
 */
export function isRecursiveForceDelete(fullCommand: string): boolean {
  const tokens = fullCommand.split(/\s+/u).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== 'rm') continue;
    // `rm` must be the command itself, or the subcommand of a known wrapper —
    // not a substring of a path that happened to tokenize alone.
    const previous = tokens[i - 1];
    if (previous !== undefined && !COMMAND_PREFIXES.has(previous)) continue;
    let recursive = false;
    let force = false;
    for (const token of tokens.slice(i + 1)) {
      if (!token.startsWith('-')) continue;
      if (token.startsWith('--')) {
        if (token === '--recursive') recursive = true;
        if (token === '--force') force = true;
        continue;
      }
      // Short flags cluster: -rf, -fr, -r, -f are all one token's letters.
      const letters = token.slice(1);
      if (/[rR]/u.test(letters)) recursive = true;
      if (/[fF]/u.test(letters)) force = true;
    }
    if (recursive && force) return true;
  }
  return false;
}

/**
 * True for a `git checkout` / `git restore` that throws away working-tree
 * changes, rather than one that just moves between branches.
 *
 * `git checkout -- .` and `git restore .` delete uncommitted work with no
 * confirmation and no reflog entry to recover from — the one genuinely
 * unrecoverable thing in everyday git. Neither was on the denylist, while
 * `git reset --hard` (which IS recoverable via reflog) was.
 *
 * `git checkout <branch>` stays allowed: git refuses it when it would clobber
 * local modifications, so it is not the hazard. `git restore --staged <path>`
 * only unstages and is likewise left alone.
 */
export function isDestructiveGitCheckout(fullCommand: string): boolean {
  const tokens = fullCommand.split(/\s+/u).filter(Boolean);
  const git = tokens.indexOf('git');
  if (git === -1) return false;
  const sub = tokens[git + 1];
  const rest = tokens.slice(git + 2);
  if (sub === 'restore') {
    // Only `--staged`/`--cached` restores leave the working tree alone.
    return !rest.some((t) => t === '--staged' || t === '--cached');
  }
  if (sub !== 'checkout') return false;
  // `--` introduces pathspecs: everything after it is a file to overwrite.
  if (rest.includes('--')) return true;
  // `git checkout .` / `git checkout src/` — a pathspec with no branch.
  return rest.some((t) => t === '.' || t.endsWith('/'));
}

/** Returns the built-in denylist covering common destructive commands. */
export function getBuiltinDenyList(): DenyListEntry[] {
  return [
    // ── Unix / cross-platform ────────────────────────────────────────────────
    // Order-agnostic: catches rm -rf, rm -r -f, rm -fr, rm -f -r, etc.
    {
      match: isRecursiveForceDelete,
      description: 'rm -rf (recursive force delete)',
      alternative:
        'To remove a path, use the delete_file tool (recursive: true for a directory). ' +
        'It moves the target to the recycle bin unless you pass to_trash: false.',
    },
    { pattern: /git\s+reset\s+--(hard|mixed|soft)/, description: 'git reset (hard/mixed/soft)' },
    {
      pattern: /git\s+clean\s+-[fFdDxX]/,
      description: 'git clean -f',
      alternative: 'To remove specific files, use the delete_file tool on each path.',
    },
    {
      match: isDestructiveGitCheckout,
      description: 'git checkout/restore discarding working-tree changes',
      alternative:
        'This deletes uncommitted work unrecoverably. To move between branches use ' +
        'the switch_branch tool; to inspect a file at a ref use git_show.',
    },
    // Every push is outward-facing, not just a forced one.
    {
      pattern: /\bgit\s+push\b/,
      description: 'git push (publishes to a remote)',
      alternative: "Publishing is the user's call — commit locally and let them push.",
    },
    { pattern: /\bgit\s+rebase\b/, description: 'git rebase (rewrites history)' },
    { pattern: /\bgit\s+branch\s+-[dD]\b/, description: 'git branch -d/-D (deletes a branch)' },
    { pattern: /\bgit\s+stash\s+(drop|clear)\b/, description: 'git stash drop/clear' },
    { pattern: /\bgit\s+filter-branch\b/, description: 'git filter-branch (rewrites history)' },
    { pattern: /\bgit\s+reflog\s+expire\b/, description: 'git reflog expire (destroys recovery)' },
    { pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)/i, description: 'SQL DROP' },
    { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, description: 'system power command' },
    { pattern: /curl\s+.+\|\s*(ba)?sh/, description: 'curl pipe to shell' },
    { pattern: /wget\s+.+-O\s*-.*\|/, description: 'wget pipe' },

    // ── Windows ───────────────────────────────────────────────────────────────
    { pattern: /del\s+\/[fFsS]/i, description: 'del /f /s' },
    { pattern: /rd\s+\/[sS]/i, description: 'rd /s' },
    { pattern: /rmdir\s+\/[sS]/i, description: 'rmdir /s' },
    { pattern: /format\s+[a-zA-Z]:/, description: 'disk format' },
    // Both flag orderings: -Recurse -Force and -Force -Recurse
    { pattern: /Remove-Item.*-Recurse.*-Force/i, description: 'PowerShell recursive force delete' },
    { pattern: /Remove-Item.*-Force.*-Recurse/i, description: 'PowerShell recursive force delete' },
    { pattern: /Invoke-Expression|^\s*iex\s/i, description: 'PowerShell eval' },
    { pattern: /-EncodedCommand|-enc\s/i, description: 'PowerShell base64 eval' },
    { pattern: /diskpart\b/i, description: 'diskpart' },
  ];
}

/**
 * Checks a command + args array against the denylist entries.
 * Returns the first matching entry, or null if none match.
 */
export function checkDenyList(
  command: string,
  args: string[],
  entries: DenyListEntry[],
): DenyListEntry | null {
  const fullCommand = [command, ...args].join(' ');
  for (const entry of entries) {
    const denied = entry.match
      ? entry.match(fullCommand)
      : (entry.pattern?.test(fullCommand) ?? false);
    if (denied) return entry;
  }
  return null;
}
