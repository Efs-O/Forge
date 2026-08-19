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
 * Replaces `/rm.*-[rR].*-?[fF]/`, whose trailing `-?[fF]` made the hyphen
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

/** Returns the built-in denylist covering common destructive commands. */
export function getBuiltinDenyList(): DenyListEntry[] {
  return [
    // ── Unix / cross-platform ────────────────────────────────────────────────
    // Order-agnostic: catches rm -rf, rm -r -f, rm -fr, rm -f -r, etc.
    {
      match: isRecursiveForceDelete,
      description: 'rm -rf (recursive force delete)',
      alternative: 'To remove a path, use the delete_file tool (recursive: true for a directory).',
    },
    { pattern: /git\s+reset\s+--(hard|mixed|soft)/, description: 'git reset (hard/mixed/soft)' },
    {
      pattern: /git\s+clean\s+-[fFdDxX]/,
      description: 'git clean -f',
      alternative: 'To remove specific files, use the delete_file tool on each path.',
    },
    { pattern: /git\s+push\s+--(force|force-with-lease)/, description: 'force push' },
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
