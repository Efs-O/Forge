import * as os from 'os';
import * as path from 'path';
import { foldDrivePath } from '../util/drivePath';
import type { ForgeConfig } from '../config/types';

/**
 * Which paths count as secrets, and how a path is decided against that list.
 *
 * The list is deliberately in code: `permissions.secret_paths` can only ADD to
 * it, so a config edit can never widen the hole by removing `~/.ssh/**`. The
 * matcher, not the list, is what this module's tests pin — a gate that approves
 * the wrong file is worse than no gate, because the agent then believes it was
 * checked.
 *
 * Matching is done on a normalised form: forward slashes, `~`/`$HOME`/
 * `%USERPROFILE%`/`$env:USERPROFILE` expanded to the home folder, and (on
 * Windows only) lower-cased, because `fsPath` lower-cases the drive letter and
 * the file system does not care about case there. On Linux and macOS the case is
 * kept: a secret named there really is case-sensitive.
 */

/** Owner-approved (2026-10-26); additions go here, never into a config file. */
export const DEFAULT_SECRET_PATTERNS: readonly string[] = [
  '~/.ssh/**',
  '**/.env',
  '**/.env.*',
  '~/.aws/**',
  '~/.forge/agent-bus/endpoint.json',
  '~/.forge/agent-bus/endpoints/*.json',
  '~/.azure/**',
  '~/.config/gcloud/**',
  '~/.kube/config',
  '~/.docker/config.json',
  '~/.npmrc',
  '~/.pypirc',
  '~/.netrc',
  '~/_netrc',
  '~/.git-credentials',
  '~/.config/gh/hosts.yml',
  '~/.gnupg/**',
  '~/.claude/.credentials.json',
  '~/.codex/auth.json',
  // Owner-approved 2026-10-28: Google's OAuth client file and the usual name for
  // a downloaded key file, wherever a project keeps them.
  '**/credentials.json',
  '**/client_secret*.json',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  'id_rsa*',
  'id_ed25519*',
];

/** Committed templates that carry variable NAMES and not their values. */
export const SECRET_TEMPLATE_EXCEPTIONS: readonly string[] = [
  '.env.example',
  '.env.sample',
  '.env.template',
];

/** What the agent is told to do instead, so a refusal changes its next move. */
export function secretDeclineHint(pattern: string): string {
  return (
    `It matched the secret-path pattern \`${pattern}\`. For variable names read a ` +
    'committed template (`.env.example`, `.env.sample`, `.env.template`) instead, or ask ' +
    'the owner to add this exact file to permissions.secret_paths_allow in config.yaml.'
  );
}

/** The line that says why the card exists, written by the gate that knows it. */
export function secretCardReason(pattern: string): string {
  return `reads a secret path (${pattern})`;
}

/** Defaults plus whatever this PC added; config can add, never subtract. */
export function secretPatternsFor(config: ForgeConfig | undefined): string[] {
  const extra = config?.permissions?.secret_paths;
  const extras = Array.isArray(extra) ? extra.filter((pattern) => typeof pattern === 'string') : [];
  return [...DEFAULT_SECRET_PATTERNS, ...extras];
}

/** Exact paths the owner allowed anyway (a deploy job that needs one `.env`). */
export function secretPathAllowListFor(config: ForgeConfig | undefined, home: string): string[] {
  const raw = config?.permissions?.secret_paths_allow;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value) => typeof value === 'string')
    .map((value) => normalizePathForMatch(expandUserTokens(value, home)));
}

/** `~`, `$HOME`, `$env:USERPROFILE` (PowerShell), `%USERPROFILE%` (cmd). */
export function expandUserTokens(value: string, home = os.homedir()): string {
  const homeNoSlash = home.replace(/[\\/]+$/u, '');
  return value
    .replace(
      /(?:^|[\\/])~(?=[\\/]|$)/gu,
      (match) => (match.startsWith('/') || match.startsWith('\\') ? match[0] : '') + homeNoSlash,
    )
    .replace(/\$env:USERPROFILE\b/giu, homeNoSlash)
    .replace(/\$HOME\b/gu, homeNoSlash)
    .replace(/%USERPROFILE%/giu, homeNoSlash);
}

/** Forward slashes, no trailing slash, and case-folded only where the OS is. */
export function normalizePathForMatch(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let slashes = value
    .replace(/\\/gu, '/')
    .replace(/\/{2,}/gu, '/')
    .replace(/\/+$/u, '');
  // The drive fold lives in `util/drivePath.ts`, shared with the sandbox. Two
  // copies of the same two rules is how one file can be a secret to this matcher
  // and an ordinary workspace path to the tool that opens it, which is the split
  // `docs/reports/SECURITY_SIMPLIFICATION_2026-10-31.md` §7 names.
  slashes = foldDrivePath(slashes, platform);
  return platform === 'win32' ? slashes.toLowerCase() : slashes;
}

/** The path API of the OS being judged, so a Windows-shaped path on a Linux
 *  runner is judged the way Windows judged it (the same idea as
 *  `ownerPaths.ts`'s `apiFor`). */
function apiFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** A path that is already absolute, in the form the matcher compares: `~` forms
 *  expanded, `..` collapsed, case folded where the OS is. undefined when it is
 *  not absolute — a relative path has no absolute form until something resolves
 *  it, and guessing against `process.cwd()` would be a guess about a folder that
 *  is not the one the tool or the command is in. */
function absoluteForMatch(
  value: string,
  home: string,
  platform: NodeJS.Platform,
): string | undefined {
  const api = apiFor(platform);
  const expanded = expandUserTokens(value, home);
  if (!api.isAbsolute(expanded)) return undefined;
  try {
    // `normalize`, not `resolve`: `resolve` consults the process's current folder
    // and, on Windows, prepends the current drive to a drive-less absolute path,
    // so a Linux-shaped path judged as Windows would come back wearing a drive it
    // never had. `normalize` only ever collapses `.` and `..` here.
    return normalizePathForMatch(api.normalize(expanded), platform);
  } catch {
    return undefined;
  }
}

/**
 * The absolute form `value` has when it is opened from `base` — the folder a
 * tool or a command runs in — with `..` collapsed and the same normalisation the
 * matcher applies: `~`/`$HOME`/`%USERPROFILE%` forms expanded, forward slashes,
 * case folded only where the file system is case-insensitive.
 *
 * Exported because `shellStatementReadsSecret` resolves its tokens against the
 * command's cwd with it: an allow entry naming `N:/ws/.env` has to excuse the
 * `cat .env` run in that workspace, not just the one typed with the full path.
 *
 * undefined when there is no `base`, or `base` is itself relative: a path that
 * cannot be located cannot be compared with an allow entry.
 */
export function resolvePathForMatch(
  value: string,
  home: string,
  platform: NodeJS.Platform,
  base?: string,
): string | undefined {
  if (base === undefined) return absoluteForMatch(value, home, platform);
  const api = apiFor(platform);
  const expandedBase = expandUserTokens(base, home);
  if (!api.isAbsolute(expandedBase)) return undefined;
  try {
    return normalizePathForMatch(
      api.resolve(expandedBase, expandUserTokens(value, home)),
      platform,
    );
  } catch {
    return undefined;
  }
}

/**
 * `**` crosses folders, `*` and `?` do not, and a pattern with no slash matches
 * at any depth. One left-to-right pass, not a chain of replaces: a `**` needs a
 * placeholder that cannot appear in a path, and `\u0000` was the first thing that
 * came to mind — a control character in a regex is what `no-control-regex`
 * exists to catch, and a NUL in a path matcher is a bug waiting to be shipped.
 *
 * Exported because `tools/fileLengthWarning.ts` matches
 * `tools.file_length_warning.globs` with it: two features reading the same
 * `**`-prefixed glob must not disagree about what it means, and a second
 * matcher in the tree is how that happens. Same normalization required — see
 * `matchesSecretPattern` below and `matchesAnyGlob` in the warning module.
 * (This comment cannot spell the usual `**` + slash + `*` + `.ts` pattern: that
 * sequence closes a block comment.)
 */
export function globToRegExp(pattern: string): RegExp {
  const anchoredAwayFromRoot = pattern.includes('/');
  let body = '';
  for (let index = 0; index < pattern.length; ) {
    if (pattern.startsWith('**/', index)) {
      body += '(?:[^/]*/)*';
      index += 3;
      continue;
    }
    if (pattern.startsWith('**', index)) {
      body += '.*';
      index += 2;
      continue;
    }
    const char = pattern[index] ?? '';
    body += /[.+^${}()|[\]\\]/u.test(char)
      ? `\\${char}`
      : char === '*'
        ? '[^/]*'
        : char === '?'
          ? '[^/]'
          : char;
    index += 1;
  }
  return new RegExp(`${anchoredAwayFromRoot ? '^' : '(?:.*/)?'}${body}$`, 'u');
}

/**
 * The pattern that `candidate` matches, or undefined when it is not a secret.
 * The allow list and the committed templates are checked first: both exist to
 * stop this gate from asking on a file the agent needs every session. The allow
 * list is checked against the candidate as typed AND, when a resolver is given,
 * against the file the tool would really open: the owner writes the list as the
 * path they mean, and the agent names the same file the way its tool sees it.
 */
export function matchesSecretPattern(
  candidate: string,
  patterns: readonly string[],
  options: {
    home?: string;
    platform?: NodeJS.Platform;
    allow?: readonly string[];
    /** Where this path really is: a file tool's own resolver, or one built from
     *  the command's cwd with `resolvePathForMatch`. Only the allow list reads
     *  its answer — the patterns stay matched against the path as named. */
    resolve?: (value: string) => string | undefined;
  } = {},
): string | undefined {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const normalized = normalizePathForMatch(expandUserTokens(candidate, home), platform);
  if (!normalized) return undefined;
  const allowed = options.allow ?? [];
  if (allowed.includes(normalized)) return undefined;
  // The same file in its resolved absolute form. The owner allows `N:/ws/.env`;
  // the agent types `.env`, because that is the same file when the workspace is
  // that folder. Comparing only the spelling the agent typed asked for a card on
  // a file the owner had already allowed — the live security test of 2026-10-28,
  // re-run finding 3. The patterns are deliberately NOT matched against this
  // form: a relative token resolved onto a folder a pattern names would newly
  // look like a secret, and the taint question — asked with nothing allowed, so
  // never reaching here — would then answer differently for one command run in
  // two different folders.
  if (allowed.length > 0 && options.resolve) {
    let fromResolver: string | undefined;
    try {
      fromResolver = options.resolve(expandUserTokens(candidate, home));
    } catch {
      // A resolver that cannot answer — `resolveWorkspacePath` with no workspace
      // folder open, a path outside every root it knows — is not a reason to
      // allow: fall back to the spelling the agent typed, which is the answer
      // this gate has always given, so the fix fails closed rather than open.
      fromResolver = undefined;
    }
    const resolved = fromResolver ? absoluteForMatch(fromResolver, home, platform) : undefined;
    if (resolved && resolved !== normalized && allowed.includes(resolved)) return undefined;
  }
  const base = normalized.split('/').at(-1) ?? '';
  if (SECRET_TEMPLATE_EXCEPTIONS.includes(base)) return undefined;
  for (const pattern of patterns) {
    const regex = globToRegExp(normalizePathForMatch(expandUserTokens(pattern, home), platform));
    if (regex.test(normalized)) return pattern;
  }
  return undefined;
}

/**
 * The pattern that names an argument a tool is about to read, or undefined when
 * reading it needs no card.
 *
 * Both forms are checked: the path as the agent typed it, and the path the tool
 * would really open (`resolve`), because `~/.ssh/id_ed25519` typed as a
 * workspace-relative string still resolves somewhere the list knows about. The
 * allow list is applied to both, and an allowed path is never re-gated by its
 * own resolved form: `.env` allowed means `.env` allowed, not `.env` asked again
 * under the longer name the resolver gave it. The other direction is the same
 * file and now gets the same answer: an owner who allowed `N:/ws/.env` has
 * allowed `.env` too, because with that workspace open they are one path. The
 * card that asked anyway was the 2026-10-28 live security test, re-run
 * finding 3.
 */
export function secretPatternForArgument(
  raw: string,
  config: ForgeConfig | undefined,
  resolve: (value: string) => string | undefined,
  options: { home?: string; platform?: NodeJS.Platform } = {},
): string | undefined {
  return secretPatternInArgument(
    raw,
    config,
    resolve,
    options,
    secretPathAllowListFor(config, options.home ?? os.homedir()),
  );
}

/**
 * The same question for the chat's taint: what this argument matches with
 * nothing allow-listed.
 *
 * `permissions.secret_paths_allow` is an escape hatch for one CARD, not for the
 * exfil rule — `config/schema.ts` says the taint "still applies to whatever it
 * lets through", and the live security test of 2026-10-28 showed what happens
 * when it does not: an unattended chat read an allow-listed `.env`, was never
 * marked, and then fetched a new host with no card at all
 * (docs/reports/V1_SECURITY_LIVE_TEST.md case 5). So every site that marks the
 * chat asks THIS question, and every site that raises a card asks the other
 * one. Two questions, one matcher, one file.
 */
export function secretPatternForTaint(
  raw: string,
  config: ForgeConfig | undefined,
  resolve: (value: string) => string | undefined,
  options: { home?: string; platform?: NodeJS.Platform } = {},
): string | undefined {
  return secretPatternInArgument(raw, config, resolve, options, []);
}

/** One matcher for both questions: the allow list is the only thing that differs. */
function secretPatternInArgument(
  raw: string,
  config: ForgeConfig | undefined,
  resolve: (value: string) => string | undefined,
  options: { home?: string; platform?: NodeJS.Platform },
  allow: readonly string[],
): string | undefined {
  if (!raw) return undefined;
  const home = options.home ?? os.homedir();
  const patterns = secretPatternsFor(config);
  const base = { ...options, home, allow };
  /** What this path matches once the owner's exceptions are applied, in either
   *  spelling: `matchesSecretPattern` compares the allow list against the
   *  resolved form too, which is what makes the early return below safe. A file
   *  the owner allowed is excused before the card whether the agent typed it
   *  relative to the workspace or absolute — returning `typed` here without that
   *  second look is exactly what asked on an allowed `.env`. */
  const gatedIn = (value: string) => matchesSecretPattern(value, patterns, { ...base, resolve });
  /** What it would match if nothing were allowed — the taint's question, asked
   *  without the resolver: the resolved form exists to answer the allow list, and
   *  with nothing allowed it is never consulted, so this answer cannot move. */
  const secretIn = (value: string) =>
    matchesSecretPattern(value, patterns, { ...base, allow: [] as string[] });
  const typed = secretIn(raw);
  if (typed && !gatedIn(raw)) return undefined;
  if (typed) return typed;
  let resolved: string | undefined;
  try {
    resolved = resolve(raw);
  } catch {
    return undefined;
  }
  if (!resolved || resolved === raw) return undefined;
  const match = secretIn(resolved);
  return match && gatedIn(resolved) ? match : undefined;
}
/**
 * The `secret:` key for one argument: the file this tool would really open, when
 * opening it can be located at all.
 *
 * `resolve` is the tool's own resolver, so the key names the file the card is about
 * rather than a spelling the agent typed — `~/.ssh/id_ed25519` and the workspace
 * path that resolves to the same file must produce the same key, or the owner's
 * "allow this file for this chat" click answers one card and not the other. When the
 * path cannot be located (a resolver that cannot answer, a relative token with no
 * folder to resolve against) there is no key, and the call asks: a key naming the
 * wrong file is an approval the owner gave to a different file.
 */
export function secretApprovalKeyFor(
  raw: string,
  resolve: (value: string) => string | undefined,
  options: { home?: string; platform?: NodeJS.Platform } = {},
): string | undefined {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const expanded = expandUserTokens(raw, home);
  let opened: string | undefined;
  try {
    opened = resolve(expanded);
  } catch {
    // A resolver that cannot answer is not a reason to guess: fall back to the
    // spelling as typed, and if that is not absolute either, there is no key.
    opened = undefined;
  }
  const resolved = resolvePathForMatch(opened ?? expanded, home, platform);
  return resolved ? `secret:${resolved}` : undefined;
}

/**
 * A shell token as a path candidate: the punctuation a redirect or a brace
 * expansion hangs on it is not part of the path.
 *
 * Exported because `tools/ownerPaths.ts` matches the same tokens against a
 * different list (the paths the agent may not change). Two matchers reading one
 * token grammar is how `git rm -f README.md` and `git rm -f notes.env.md` came
 * to be judged the same way twice, rather than differently.
 */
export function tokenPathCandidate(token: string): string {
  return token.replace(/^[([{<>=,;'"`]+/u, '').replace(/[)\]>,;'"`]+$/u, '');
}

/**
 * A token that carries a path separator and a run-time expansion (`src/$name`,
 * `%USERPROFILE%\certs`, a backtick substitution).
 */
const TOKEN_EXPANSION = /[$][A-Za-z_{(]|%[A-Za-z_][A-Za-z0-9_]*%|![A-Za-z_][A-Za-z0-9_]*!|`/u;
const PATH_SEPARATOR_TOKEN = /[\\/]/u;

/**
 * Is an argument built at run time rather than written out? `Get-Content
 * ("~/.s" + "sh/id_rsa")` names no secret to a token matcher, and `cat
 * src/$name` names none either — the path is not known until the shell runs. A
 * read-only command that builds its path this way must ask, whatever the
 * computed path turns out to be (docs/plans/EXFIL_GATES_PLAN.md, phase-1 trap).
 *
 * Only run-time expansion counts: brace expansion (`ls src/{a,b}.ts`) is written
 * out, and a `$` or a `+` inside a search regex (`rg '\d+$' src/`) is not a path
 * being built, so neither asks. `parseCommand` already disqualifies `$(` and a
 * backtick from read-only, so this only has to catch what the parser lets
 * through as a read: concatenation (a lone `+` token, because `parseCommand`
 * strips the quote characters around it) and a plain variable (`src/$name`).
 * Same-line literal bash variables are substituted by `shellPolicy.ts` before
 * this check. The residual gap is a path assembled at run time by a script,
 * `python -c`, command substitution, or concatenation with no token boundary.
 */
export function argumentLooksComputed(tokens: readonly string[]): boolean {
  const args = tokens.slice(1);
  if (!args.some((token) => PATH_SEPARATOR_TOKEN.test(token))) return false;
  return args.some(
    (token) => (PATH_SEPARATOR_TOKEN.test(token) && TOKEN_EXPANSION.test(token)) || token === '+',
  );
}
