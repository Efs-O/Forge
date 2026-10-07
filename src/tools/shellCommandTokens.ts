/** Program and Git invocation normalization shared by shell classification rules. */

export function baseProgram(value: string): string {
  return (value.split(/[\\/]/u).pop() ?? value).replace(/\.(exe|cmd|bat)$/iu, '').toLowerCase();
}

const PREFIXES = new Set(['sudo', 'doas', 'command', 'env']);
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);
const GIT_SWITCHES = new Set([
  '-p',
  '-P',
  '--paginate',
  '--no-pager',
  '--bare',
  '--no-replace-objects',
  '--no-lazy-fetch',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
]);

export interface GitInvocation {
  /** The tokens with git's global options (and their values) removed. */
  command: readonly string[];
  /** The removed global options and values. */
  globals: readonly string[];
  /** A global option outside the known sets was skipped, e.g. `--exec-path=/x`. */
  unknownGlobal: boolean;
}

/**
 * Splits git's global options off the subcommand. Unknown options are skipped
 * too, so a deny rule still finds `reset --hard` after one, and are flagged so a
 * read-only check can refuse what it does not understand.
 */
export function splitGitGlobals(tokens: readonly string[]): GitInvocation {
  let gitIndex = 0;
  while (PREFIXES.has(baseProgram(tokens[gitIndex] ?? ''))) gitIndex += 1;
  if (tokens[gitIndex] === '&') gitIndex += 1;
  if (baseProgram(tokens[gitIndex] ?? '') !== 'git') {
    return { command: tokens, globals: [], unknownGlobal: false };
  }
  let index = gitIndex + 1;
  let unknownGlobal = false;
  while (index < tokens.length) {
    const option = tokens[index] ?? '';
    if (GIT_VALUE_OPTIONS.has(option)) {
      if (index + 1 >= tokens.length) break;
      index += 2;
    } else if (
      GIT_SWITCHES.has(option) ||
      /^--(?:git-dir|work-tree|namespace|config-env)=/u.test(option) ||
      /^-[Cc].+/u.test(option)
    ) {
      index += 1;
    } else if (/^-./u.test(option)) {
      unknownGlobal = true;
      index += 1;
    } else {
      break;
    }
  }
  return {
    command: [...tokens.slice(0, gitIndex + 1), ...tokens.slice(index)],
    globals: tokens.slice(gitIndex + 1, index),
    unknownGlobal,
  };
}

/** Remove Git global options before the subcommand, including their values. */
export function gitCommandTokens(tokens: readonly string[]): readonly string[] {
  return splitGitGlobals(tokens).command;
}
