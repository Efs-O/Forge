import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_PATTERNS,
  SECRET_TEMPLATE_EXCEPTIONS,
  argumentLooksComputed,
  expandUserTokens,
  matchesSecretPattern,
  normalizePathForMatch,
  resolvePathForMatch,
  secretCardReason,
  secretDeclineHint,
  secretPathAllowListFor,
  secretPatternForArgument,
  secretPatternForTaint,
  secretPatternsFor,
} from '../../src/tools/secretPaths';
// The shell-statement scanners moved to `shellSecretReads.ts` with the token half of
// the secret gate; the matcher they use still lives in `secretPaths.ts`.
import { shellStatementReadsSecret } from '../../src/tools/shellSecretReads';
import type { ForgeConfig } from '../../src/config/types';

const HOME = 'C:/Users/someone';
const win = { home: HOME, platform: 'win32' as const };
const nix = { home: '/home/someone', platform: 'linux' as const };

/** Every allow-list case has to be judged with the runner's own OS in mind, not with
 *  the faked `win32` above: `secretPathAllowListFor` normalises the owner's entries
 *  with `process.platform` (it is handed no platform), so a faked `win32` on a Linux
 *  runner folds the case of the candidate while the entry keeps its own, and the two
 *  spellings of one file stop matching. On Windows this is `win` itself. */
const runner = { home: HOME, platform: process.platform };
/** The workspace the owner names in the allow list, in a form every runner calls
 *  absolute — `N:/ws` is a folder called `N:` on Linux and macOS. */
const WORKSPACE = path
  .resolve('/ws')
  .replace(/\\/gu, '/');
/** The same folder upper-cased and backslash-spelled, which only a case-insensitive
 *  file system reads as the one file, so it is added on Windows only. */
const WORKSPACE_FOLDED = WORKSPACE.toUpperCase().replace(/\//gu, '\\');

/**
 * The matcher, not the list, is what these tests pin. A gate that approves the
 * wrong file is worse than no gate: the agent then believes the read was checked
 * and sends what it read. Every pattern below is one the owner approved on
 * 2026-10-26 (docs/plans/EXFIL_GATES_PLAN.md § "Part B"), the two credentials
 * file patterns on 2026-10-28.
 */
describe('the secret-path list matches what it names', () => {
  const cases: Array<[pattern: string, candidate: string]> = [
    ['~/.ssh/**', '~/.ssh/id_ed25519'],
    ['~/.ssh/**', '~/.ssh/config'],
    ['~/.ssh/**', '~/.ssh/known_hosts.old'],
    ['**/.env', '.env'],
    ['**/.env', 'src/.env'],
    ['**/.env', 'apps/api/.env'],
    ['**/.env.*', '.env.production'],
    ['**/.env.*', 'apps/api/.env.local'],
    ['~/.aws/**', '~/.aws/credentials'],
    ['~/.forge/agent-bus/endpoint.json', '~/.forge/agent-bus/endpoint.json'],
    ['~/.forge/agent-bus/endpoints/*.json', '~/.forge/agent-bus/endpoints/job.json'],
    ['~/.azure/**', '~/.azure/accessTokens.json'],
    ['~/.config/gcloud/**', '~/.config/gcloud/credentials.db'],
    ['~/.kube/config', '~/.kube/config'],
    ['~/.docker/config.json', '~/.docker/config.json'],
    ['~/.npmrc', '~/.npmrc'],
    ['~/.pypirc', '~/.pypirc'],
    ['~/.netrc', '~/.netrc'],
    ['~/_netrc', '~/_netrc'],
    ['~/.git-credentials', '~/.git-credentials'],
    ['~/.config/gh/hosts.yml', '~/.config/gh/hosts.yml'],
    ['~/.gnupg/**', '~/.gnupg/openpgp-revocs.d/ABCD.rev'],
    ['~/.claude/.credentials.json', '~/.claude/.credentials.json'],
    ['~/.codex/auth.json', '~/.codex/auth.json'],
    ['**/credentials.json', 'credentials.json'],
    ['**/credentials.json', 'tools/sheets-bot/credentials.json'],
    ['**/client_secret*.json', 'client_secret_1234-abcd.apps.googleusercontent.com.json'],
    ['*.pem', 'certs/server.pem'],
    ['*.key', 'certs/server.key'],
    ['*.pfx', 'C:/certs/pfx/client.pfx'],
    ['*.p12', 'C:/certs/pfx/client.p12'],
    ['id_rsa*', 'deploy/id_rsa'],
    ['id_ed25519*', 'deploy/id_ed25519-sk'],
  ];

  it.each(cases)('gates %s when the agent reaches for %s', (pattern, candidate) => {
    expect(matchesSecretPattern(candidate, DEFAULT_SECRET_PATTERNS, win)).toBe(pattern);
  });

  // A public key is not a secret, and `*.pub` is deliberately NOT on the list.
  // `id_rsa.pub` is still gated, because `id_rsa*` cannot tell them apart — an
  // over-gate on a harmless file, cheaper than a matcher that could miss a key.
  it('does not gate public keys in general, only the ones a key pattern reaches', () => {
    expect(matchesSecretPattern('deploy/deployment.pub', DEFAULT_SECRET_PATTERNS, win)).toBe(
      undefined,
    );
    expect(DEFAULT_SECRET_PATTERNS.some((pattern) => pattern.includes('.pub'))).toBe(false);
  });

  // The committed templates carry variable NAMES, not values, and the agent
  // reads them every session: asking there is the fastest way to make the gate
  // get switched off by an annoyed owner.
  it('lets the committed templates through', () => {
    for (const template of SECRET_TEMPLATE_EXCEPTIONS) {
      expect(matchesSecretPattern(template, DEFAULT_SECRET_PATTERNS, win)).toBeUndefined();
      expect(matchesSecretPattern(`src/${template}`, DEFAULT_SECRET_PATTERNS, win)).toBeUndefined();
    }
    expect(matchesSecretPattern('.env.releases', DEFAULT_SECRET_PATTERNS, win)).toBe('**/.env.*');
  });

  it('still asks for a file named like a template but not one', () => {
    expect(matchesSecretPattern('.env.example.local', DEFAULT_SECRET_PATTERNS, win)).toBe(
      '**/.env.*',
    );
  });
});

describe('the home folder is expanded before matching', () => {
  // `~`, `$HOME`, PowerShell's `$env:USERPROFILE` and cmd's `%USERPROFILE%` all
  // name the same file, and the agent types all four. A gate that only knew `~`
  // would be answered by the other three.
  it('accepts every spelling of the home folder', () => {
    for (const candidate of [
      '~/.ssh/id_rsa',
      '$HOME/.ssh/id_rsa',
      '$env:USERPROFILE\\.ssh\\id_rsa',
      '%USERPROFILE%\\.ssh\\id_rsa',
      'C:/Users/someone/.ssh/id_rsa',
      'C:\\Users\\someone\\.ssh\\id_rsa',
    ]) {
      expect(matchesSecretPattern(candidate, DEFAULT_SECRET_PATTERNS, win)).toBe('~/.ssh/**');
    }
  });

  it('expands each form onto the home folder it is given', () => {
    expect(expandUserTokens('~/.ssh/id_rsa', HOME)).toBe(`${HOME}/.ssh/id_rsa`);
    expect(expandUserTokens('~/notes/todo.md', '/home/u')).toBe('/home/u/notes/todo.md');
    expect(expandUserTokens('$HOME/.aws/credentials', '/home/u')).toBe('/home/u/.aws/credentials');
    expect(expandUserTokens('$env:USERPROFILE\\.npmrc', 'C:/h')).toBe('C:/h\\.npmrc');
    expect(expandUserTokens('%USERPROFILE%/.npmrc', 'C:/h')).toBe('C:/h/.npmrc');
    // A `~` that is not at the start of a path segment is part of a name.
    expect(expandUserTokens('a~b/x.txt', '/home/u')).toBe('a~b/x.txt');
  });

  // `fsPath` lower-cases the drive letter, so the matcher must fold case where
  // the file system does — and only there. On Linux `Secret` and `secret` are
  // two files, and folding there would let `~/.SSH` or `.NPMRC` slip past.
  it('folds case on Windows and keeps it on Linux', () => {
    expect(matchesSecretPattern('c:/users/someone/.ssh/id_rsa', DEFAULT_SECRET_PATTERNS, win)).toBe(
      '~/.ssh/**',
    );
    expect(matchesSecretPattern('/home/someone/.npmrc', DEFAULT_SECRET_PATTERNS, nix)).toBe(
      '~/.npmrc',
    );
    expect(
      matchesSecretPattern('/HOME/someone/.npmrc', DEFAULT_SECRET_PATTERNS, nix),
    ).toBeUndefined();
    expect(
      matchesSecretPattern('/home/someone/.NPMRC', DEFAULT_SECRET_PATTERNS, nix),
    ).toBeUndefined();
  });

  it('normalises separators and trailing slashes, and folds case only where the OS does', () => {
    expect(normalizePathForMatch('C:\\Users\\someone\\.ssh\\id_rsa', 'win32')).toBe(
      'c:/users/someone/.ssh/id_rsa',
    );
    expect(normalizePathForMatch('/home/u//x/', 'linux')).toBe('/home/u/x');
    expect(normalizePathForMatch('/Home/U/X', 'linux')).toBe('/Home/U/X');
    expect(normalizePathForMatch('/Home/U/X', 'win32')).toBe('/home/u/x');
  });
});

describe('config can add to the list, never subtract', () => {
  const config: ForgeConfig = {
    permissions: { secret_paths: ['N:/vs code apps/private-repo/**'] },
  } as ForgeConfig;

  it('appends what this PC added to the defaults', () => {
    const patterns = secretPatternsFor(config);
    expect(patterns).toEqual([...DEFAULT_SECRET_PATTERNS, 'N:/vs code apps/private-repo/**']);
    expect(matchesSecretPattern('N:/vs code apps/private-repo/notes.md', patterns, win)).toBe(
      'N:/vs code apps/private-repo/**',
    );
  });

  // Deleting `~/.ssh/**` from a config file must not open the gate: the hole
  // this list closes is why it lives in code.
  it('applies the defaults whether or not config says anything', () => {
    for (const value of [
      undefined,
      {},
      { permissions: {} },
      { permissions: { secret_paths: [] } },
    ]) {
      expect(secretPatternsFor(value as ForgeConfig)).toEqual([...DEFAULT_SECRET_PATTERNS]);
    }
    expect(secretPatternsFor({} as ForgeConfig)).toContain('~/.ssh/**');
  });

  it('ignores a non-string entry instead of throwing on a bad edit', () => {
    const broken = { permissions: { secret_paths: [42, '~/.vault/**'] } } as unknown as ForgeConfig;
    expect(secretPatternsFor(broken)).toEqual([...DEFAULT_SECRET_PATTERNS, '~/.vault/**']);
  });
});

describe('permissions.secret_paths_allow is the escape hatch', () => {
  const allow = (paths: string[]): ForgeConfig =>
    ({ permissions: { secret_paths_allow: paths } }) as ForgeConfig;
  // A tool that resolves its path passes its own resolver in; the identity here
  // says "the path as typed is the path read", which is what these cases are
  // about. The resolved form has its own case below.
  const gate = (raw: string, config: ForgeConfig) =>
    secretPatternForArgument(raw, config, (value) => value, win);

  it('lets one named file through and nothing else', () => {
    expect(gate('.env', allow(['.env']))).toBeUndefined();
    expect(gate('.env', allow(['src/.env']))).toBe('**/.env');
    expect(gate('.env.local', allow(['.env']))).toBe('**/.env.*');
  });

  // A deploy job that needs one `.env.production` gets it by naming the exact
  // path, in whatever spelling the owner typed.
  // The escape hatch pinning a Windows allow list: `$env:USERPROFILE\`, a `C:\` path,
  // and the lower-cased form that comes back are Windows spellings and a Windows fold,
  // so this one runs where a drive letter and a case-insensitive file system exist.
  it.skipIf(process.platform !== 'win32')(
    'normalises the allow list the same way it normalises candidates',
    () => {
      expect(gate('~/.ssh/id_rsa', allow(['$env:USERPROFILE\\.ssh\\id_rsa']))).toBeUndefined();
      expect(secretPathAllowListFor(allow(['C:\\Users\\someone\\.ssh\\id_rsa']), HOME)).toEqual([
        'c:/users/someone/.ssh/id_rsa',
      ]);
      expect(secretPathAllowListFor(undefined, HOME)).toEqual([]);
    },
  );

  // The case the escape hatch would have broken without this rule: `.env` is
  // allowed, the resolver hands the tool `/work/project/.env`, which the allow
  // list does not name. Re-gating it there would make the hatch unusable for
  // exactly the workspace file it was written for.
  it('does not re-gate an allowed path under its resolved form', () => {
    const resolved = '/work/project/.env';
    expect(secretPatternForArgument('.env', allow(['.env']), () => resolved, nix)).toBeUndefined();
    expect(secretPatternForArgument('.env', allow(['src/.env']), () => resolved, nix)).toBe(
      '**/.env',
    );
  });

  it('gates the resolved form when the typed form named nothing', () => {
    // `.ssh/config` typed as a workspace-relative path names nothing on its own,
    // and the resolver puts it where `~/.ssh/**` lives.
    expect(
      secretPatternForArgument('.ssh/config', undefined, () => '/home/someone/.ssh/config', nix),
    ).toBe('~/.ssh/**');
    // A resolver that throws (a path outside every workspace) is not a secret.
    expect(
      secretPatternForArgument(
        'notes.md',
        undefined,
        () => {
          throw new Error('no workspace');
        },
        nix,
      ),
    ).toBeUndefined();
  });

  // The owner writes the allow list as the path they mean — the absolute one — and
  // the agent names the same file the way its tool sees it: `.env`, when the
  // workspace IS that folder. Comparing only the spelling the agent typed asked
  // for a card on a file the owner had already allowed (the live security test of
  // 2026-10-28, re-run finding 3). `N:/ws` stands for the workspace the owner put
  // in the list, and `atWorkspace` is the resolver a file tool hands in.
  const WS = WORKSPACE;
  const atWorkspace = (value: string): string | undefined =>
    resolvePathForMatch(value, HOME, process.platform, WS);

  it('excuses the allowed file however the agent spells it, and nothing else', () => {
    const allowed = allow([`${WS}/.env`]);
    const gateAt = (raw: string) => secretPatternForArgument(raw, allowed, atWorkspace, runner);
    const spellings = ['.env', './.env', 'x/../.env', `${WS}/.env`];
    if (process.platform === 'win32') spellings.push(`${WORKSPACE_FOLDED}\\.ENV`);
    for (const spelling of spellings) {
      expect(gateAt(spelling), `${spelling} should be allowed`).toBeUndefined();
    }
    for (const [spelling, pattern] of [
      ['other/.env', '**/.env'],
      [`${WS}/other/.env`, '**/.env'],
      ['.env.local', '**/.env.*'],
      [`${WS}/.env.local`, '**/.env.*'],
    ] as const) {
      expect(gateAt(spelling), `${spelling} should still ask`).toBe(pattern);
    }
    // A resolver that cannot answer — `resolveWorkspacePath` with no workspace
    // folder open, which is how `git_read` is registered in a window with none —
    // fails closed. The file is still gated, exactly as it was before this fix.
    expect(
      secretPatternForArgument(
        '.env',
        allowed,
        () => {
          throw new Error('No workspace folder open; use an explicit absolute path.');
        },
        win,
      ),
    ).toBe('**/.env');
  });

  // The same file through the shell gate: `cat .env` run in that workspace names
  // the allowed path once its token is resolved against the command's cwd, so it
  // asks for nothing — and a different cwd is a different file, which still asks.
  it('reads the allow list against the folder the command runs in', () => {
    const entries = secretPathAllowListFor(allow([`${WS}/.env`]), HOME);
    const read = (tokens: string[], cwd: string) =>
      shellStatementReadsSecret(tokens, DEFAULT_SECRET_PATTERNS, {
        ...runner,
        allow: entries,
        cwd,
      });
    const spellings = ['.env', './.env', `${WS}/.env`];
    if (process.platform === 'win32') spellings.push(`${WORKSPACE_FOLDED}\\.ENV`);
    for (const spelling of spellings) {
      expect(read(['cat', spelling], WS), `${spelling} should read freely`).toBeUndefined();
    }
    expect(read(['cat', 'other/.env'], WS)).toBe('**/.env');
    expect(read(['cat', '.env.local'], WS)).toBe('**/.env.*');
    expect(read(['cat', '.env'], `${WS}/other`)).toBe('**/.env');
    // No cwd, nothing to resolve against: the answer a window with no folder open
    // has always given, pinned so this fix cannot have quietly widened it.
    expect(
      shellStatementReadsSecret(['cat', '.env'], DEFAULT_SECRET_PATTERNS, {
        ...runner,
        allow: entries,
      }),
    ).toBe('**/.env');
  });
});

// The escape hatch skips a read's CARD, never the chat's taint: `config/schema.ts`
// says the taint "still applies to whatever it lets through", and the live
// security test of 2026-10-28 (docs/reports/V1_SECURITY_LIVE_TEST.md case 5)
// found what happens when it does not — an unattended chat read an allow-listed
// `.env`, was never marked, and then fetched a new host with no card at all. Two
// questions, one matcher, and this file pins the difference between them.
describe('the taint question ignores the allow list', () => {
  const allow = (paths: string[]): ForgeConfig =>
    ({ permissions: { secret_paths_allow: paths } }) as ForgeConfig;
  const card = (raw: string, config: ForgeConfig) =>
    secretPatternForArgument(raw, config, (value) => value, runner);
  const taint = (raw: string, config: ForgeConfig) =>
    secretPatternForTaint(raw, config, (value) => value, runner);

  it('still names the pattern for the exact path the owner allowed', () => {
    expect(card('.env', allow(['.env']))).toBeUndefined();
    expect(taint('.env', allow(['.env']))).toBe('**/.env');
  });

  // The hatch exists for a deploy job's one `.env.production`, in whatever
  // spelling the owner typed; the job still read a secret, so the chat is still
  // marked for its next fetch.
  it('marks the home-folder file an allowed spelling names', () => {
    expect(card('~/.ssh/id_rsa', allow(['$env:USERPROFILE\\.ssh\\id_rsa']))).toBeUndefined();
    expect(taint('~/.ssh/id_rsa', allow(['$env:USERPROFILE\\.ssh\\id_rsa']))).toBe('~/.ssh/**');
  });

  // A committed template carries variable NAMES, not values, and is not a
  // secret at all: the taint must not reach it either, or every `.env.example`
  // read would gate the chat's next fetch for nothing.
  it('does not taint the committed templates', () => {
    for (const filePath of ['.env.example', '.env.sample', '.env.template', 'src/.env.example']) {
      expect(taint(filePath, allow([filePath]))).toBeUndefined();
      expect(taint(filePath, undefined)).toBeUndefined();
    }
  });

  // With nothing allowed the two questions have the same answer, so the taint
  // matcher cannot be the one that quietly stopped gating anything.
  it('agrees with the card question when nothing is allowed', () => {
    for (const filePath of ['.env', 'src/.env.local', '~/.ssh/id_rsa', 'notes.md', 'src/app.ts']) {
      expect(taint(filePath, undefined)).toBe(card(filePath, undefined));
    }
  });

  // The resolved form too: `.env` allowed as a workspace file, the resolver
  // hands back `/home/someone/.ssh/config` for `.ssh/config`, and the allow list
  // does not name that — the card is raised there anyway, and the taint holds.
  it('marks what only the resolved form names', () => {
    expect(
      secretPatternForTaint(
        '.ssh/config',
        allow(['.ssh/config']),
        () => '/home/someone/.ssh/config',
        nix,
      ),
    ).toBe('~/.ssh/**');
    expect(secretPatternForTaint('.env', allow(['.env']), () => '/work/project/.env', nix)).toBe(
      '**/.env',
    );
  });

  // Finding 3's fix recognises an allowed file in either spelling. It must not
  // widen the hatch: the card goes away and the chat is still marked, because the
  // escape hatch is one prompt's exemption, not the exfil rule's.
  it('marks the file the owner allowed, in the spelling the agent typed', () => {
    const WS = WORKSPACE;
    const allowed = allow([`${WS}/.env`]);
    const atWorkspace = (value: string): string | undefined =>
      resolvePathForMatch(value, HOME, process.platform, WS);
    expect(secretPatternForArgument('.env', allowed, atWorkspace, runner)).toBeUndefined();
    expect(secretPatternForTaint('.env', allowed, atWorkspace, runner)).toBe('**/.env');
  });
});

// The resolved form answers the allow list and nothing else. Had the patterns been
// matched against it too, a token resolved onto a folder a pattern names would
// newly look like a secret, and the shell gate's taint answer would move with the
// command's cwd. Asked with nothing allowed — the taint's shape — the resolver is
// never consulted at all, so that answer cannot move.
describe('the resolved form answers the allow list, never the patterns', () => {
  const WS = 'N:/ws';
  const atWorkspace = (value: string): string | undefined =>
    resolvePathForMatch(value, HOME, 'win32', WS);
  const withResolver = { ...win, allow: ['n:/ws/other'], resolve: atWorkspace };
  const patterns = secretPatternsFor({
    permissions: { secret_paths: ['N:/ws/private/**'] },
  } as unknown as ForgeConfig);

  it('does not turn a path that only its resolved form would match into a secret', () => {
    expect(matchesSecretPattern('private/notes.md', patterns, withResolver)).toBeUndefined();
    // The absolute spelling is what the pattern names, and it still gates.
    expect(matchesSecretPattern('N:/ws/private/notes.md', patterns, withResolver)).toBe(
      'N:/ws/private/**',
    );
  });

  it('is not consulted when nothing is allowed, which is the taint question', () => {
    expect(
      matchesSecretPattern('.env', DEFAULT_SECRET_PATTERNS, {
        ...win,
        allow: [],
        resolve: atWorkspace,
      }),
    ).toBe('**/.env');
  });
});

describe('whole tokens only, never substrings', () => {
  // `git rm -f notes.env.md` is not a `.env` read, and a substring rule would
  // have made every command that mentions `.env` inside a longer name ask for
  // approval (docs/CLAUDE.md, Agent-Ergonomics Traps).
  it('reads the path in a token, not the text of a token', () => {
    const read = (tokens: string[]) =>
      shellStatementReadsSecret(tokens, DEFAULT_SECRET_PATTERNS, win);
    expect(read(['Get-Content', '.env'])).toBe('**/.env');
    expect(read(['cat', '~/.ssh/id_rsa'])).toBe('~/.ssh/**');
    expect(read(['type', '%USERPROFILE%\\.aws\\credentials'])).toBe('~/.aws/**');
    expect(read(['rg', 'KEY', '.env'])).toBe('**/.env');
    expect(read(['git', 'rm', '-f', 'notes.env.md'])).toBeUndefined();
    expect(read(['cat', 'notes.env.md'])).toBeUndefined();
    expect(read(['cat', 'environment.md'])).toBeUndefined();
    // An `option=path` argument is an option, not a path the command reads.
    expect(read(['rg', '--glob=**.env', 'KEY'])).toBeUndefined();
    expect(read(['grep', '-i', 'password', '.env'])).toBe('**/.env');
    expect(read(['grep', '-in', 'KEY', '.env'])).toBe('**/.env');
    expect(read(['grep', '-v', 'x', '--', '.env'])).toBe('**/.env');
    expect(read(['rg', '-i', 'token', '.env'])).toBe('**/.env');
    expect(read(['grep', '-f', '.env', 'x'])).toBe('**/.env');
    expect(read(['cat', '$env:HOME\\.ssh\\id_rsa'])).toBe('~/.ssh/**');
    expect(read(['Get-Content'])).toBeUndefined();
  });

  it('strips the punctuation a token carries around a path', () => {
    expect(shellStatementReadsSecret('("C:/Users/someone/.ssh/id_rsa")'.split(' '), [], win)).toBe(
      undefined,
    );
    const tokens = ['Get-Content', '("C:/Users/someone/.ssh/id_rsa")'];
    expect(shellStatementReadsSecret(tokens, DEFAULT_SECRET_PATTERNS, win)).toBe('~/.ssh/**');
  });
});

describe('a path built at run time cannot be judged, so it asks', () => {
  // The phase-1 trap in docs/plans/EXFIL_GATES_PLAN.md: `Get-Content ("~/.s" +
  // "sh/id_rsa")` and `cat src/$name` name no secret to a token matcher, because
  // the path does not exist until the shell runs. `parseCommand` strips quote
  // characters, so concatenation survives as a lone `+` token.
  const computed = (tokens: string[]) => argumentLooksComputed(tokens);
  it('catches concatenation and expansion', () => {
    // `parseCommand` already disqualifies `$(` and a backtick from read-only, so
    // the only forms this helper has to catch are the ones the parser lets
    // through as a read: string concatenation and a plain variable.
    expect(computed(['Get-Content', '(~/.s', '+', 'sh/id_rsa)'])).toBe(true);
    expect(computed(['Get-Content', ...'(C:/a + b)'.split(' ')])).toBe(true);
    expect(computed(['cat', 'src/$name'])).toBe(true);
    expect(computed(['cat', '$HOME/x'])).toBe(true);
    expect(computed(['type', '%TEMP%\\notes.txt'])).toBe(true);
    expect(computed(['Get-Content', 'C:/a/', '+', 'b.txt'])).toBe(true);
  });

  // What must NOT count: brace expansion is written out, and a `$` or a `+`
  // inside a search regex is not a path being built. Getting this wrong makes
  // `rg` ask for approval on half the searches in the repo.
  it('leaves written-out paths and regexes alone', () => {
    expect(computed(['ls', 'src/{a,b}.ts'])).toBe(false);
    expect(computed(['rg', String.raw`\d+$`, 'src/'])).toBe(false);
    expect(computed(['rg', String.raw`foo\.\w+`, 'src/'])).toBe(false);
    expect(computed(['Get-Content', 'C:\\notes.txt'])).toBe(false);
    expect(computed(['Get-Process', '|', 'Where-Object', '{', '$_.Name', '-eq', 'node', '}'])).toBe(
      false,
    );
    expect(computed(['cat', 'src/app.ts'])).toBe(false);
  });
});

describe('a refusal says what the agent should do instead', () => {
  it('names the pattern on the card and the alternative in the decline', () => {
    expect(secretCardReason('**/.env')).toBe('reads a secret path (**/.env)');
    const hint = secretDeclineHint('~/.ssh/**');
    expect(hint).toContain('~/.ssh/**');
    expect(hint).toContain('.env.example');
    expect(hint).toContain('permissions.secret_paths_allow');
  });
});
