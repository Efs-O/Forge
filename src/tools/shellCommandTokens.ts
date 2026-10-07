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

/** Remove only Git global options before the subcommand, including their values. */
export function gitCommandTokens(tokens: readonly string[]): readonly string[] {
  let gitIndex = 0;
  while (PREFIXES.has(baseProgram(tokens[gitIndex] ?? ''))) gitIndex += 1;
  if (tokens[gitIndex] === '&') gitIndex += 1;
  if (baseProgram(tokens[gitIndex] ?? '') !== 'git') return tokens;
  let index = gitIndex + 1;
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
    } else {
      break;
    }
  }
  return [...tokens.slice(0, gitIndex + 1), ...tokens.slice(index)];
}
