/**
 * Platform-aware command denylist.
 * Checked before any exec_command or run_terminal dispatch.
 */

export interface DenyListEntry {
  pattern: RegExp;
  description: string;
}

/** Returns the built-in denylist covering common destructive commands. */
export function getBuiltinDenyList(): DenyListEntry[] {
  return [
    // ── Unix / cross-platform ────────────────────────────────────────────────
    // Order-agnostic: catches rm -rf, rm -r -f, rm -fr, rm -f -r, etc.
    {
      pattern: /\brm\b.*-[rR].*-?[fF]|\brm\b.*-[fF].*-?[rR]/,
      description: 'rm -rf (recursive force delete)',
    },
    { pattern: /git\s+reset\s+--(hard|mixed|soft)/, description: 'git reset (hard/mixed/soft)' },
    { pattern: /git\s+clean\s+-[fFdDxX]/, description: 'git clean -f' },
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
    if (entry.pattern.test(fullCommand)) {
      return entry;
    }
  }
  return null;
}
