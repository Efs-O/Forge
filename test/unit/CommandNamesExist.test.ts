/**
 * Phase B CI check 4 (`docs/plans/AGENT_DOCS_GAP_AUDIT_PLAN.md` § "Phase B
 * scope"): every slash command the store page and the install-facing docs tell
 * a reader to type must be a command the product handles, and every
 * `**Forge: X**` palette entry must be in `package.json`.
 *
 * Phase A rows this is the teeth for:
 * - C3: `docs/LLAMACPP_INSTALL.md:27` told the reader `/restartBackend`; the
 *   typed trigger is `/restart` (`webview-ui/src/slashCommands.ts:132`), and
 *   `docs/LLAMACPP_UPDATE.md:70` made the same claim.
 * - C4: `README.md:102-103` said persistent jobs run "from the sidebar … with
 *   `/jobs`", while `/jobs` is a Telegram command (`src/remote/remoteHelpText.ts:127`)
 *   and the sidebar has no jobs command at all.
 *
 * `DocClaimsDrift.test.ts` already compares README's slash table and the phone
 * command paragraph against code. This widens the net to any backticked
 * single-word `/command` in the docs that tell a reader what to type, and to
 * the palette titles, so a command rename cannot leave a doc pointing at a name
 * nothing accepts.
 *
 * What counts as a claim: a backticked span whose whole text is `/word`
 * (lowercase, one segment). That is how these docs write a command, and it
 * keeps path segments (`docs/JOBS.md`, `C:/Program Files/Git/bin/bash.exe`) and
 * arithmetic (`num_ctx / n_parallel`) out of the set. History documents are
 * skipped: they quote commands that were valid when they were written, and a
 * check that fails on a 2026-08 audit report teaches nothing.
 *
 * Canonical comes from code, not a hand-typed list, and it is typed names only:
 * sidebar triggers (an `id` is what `src/sidebar/SlashCommandHandler.ts`
 * dispatches on and is never typed — accepting ids is what let
 * `/restartBackend` pass unnoticed), the Telegram inventory in
 * `remoteHelpText.ts` plus every `'/word'` literal and every regex-anchored
 * command the remote handlers carry, and the control-server routes (a doc
 * naming `/ensure` means an HTTP route, not something to type). The four
 * exceptions named below are the only hand-typed entries, each with the code
 * that says why it is not something a reader types today.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

/** Documents that tell a reader what to type. A local file that is absent on a
 *  checkout (CLAUDE.md, AGENTS.md, docs/plans/) is skipped, not failed. */
const INSTRUCTION_SOURCES = [
  'README.md',
  'AI_SETUP.md',
  'ROADMAP.md',
  ...fs
    .readdirSync(path.join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
];
/** History: audits, reviews, plans, benchmarks, findings, TODOs. They quote the
 *  command names of their own era, so a wrong name there is not a live claim. */
const HISTORY_NAME =
  /(AUDIT|REVIEW|BENCHMARK|PLAN|REPORT|FINDINGS|INVESTIGATION|TODO|HARDENING|CONCURRENCY|METADATA|THINKING|STATS|GAP|RISK|SMOKE|SPIKE|WATCH|MEASUREMENT|HANDOFF|SESSION|BENCH)/iu;

const sources = INSTRUCTION_SOURCES.filter(
  (relative) => !HISTORY_NAME.test(path.basename(relative)) && fs.existsSync(path.join(root, relative)),
);

/** Backticked spans that are exactly one lowercase slash word. */
const claimedCommands = (markdown: string): Set<string> => {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/`([^`\n]+)`/gu)) {
    const span = match[1] ?? '';
    const command = /^\/([a-z][A-Za-z0-9]*)$/u.exec(span);
    if (command) found.add(command[1] as string);
  }
  return found;
};

const claims = new Map<string, string[]>();
for (const relative of sources) {
  for (const command of claimedCommands(read(relative))) {
    const where = claims.get(command) ?? [];
    where.push(relative);
    claims.set(command, where);
  }
}

/** Sidebar: the names the composer accepts. A `trigger` is typed text; an `id`
 *  is what the handler dispatches on (`src/sidebar/SlashCommandHandler.ts:113`
 *  `case 'restartBackend':`) and is never typed, so ids stay out of the
 *  canonical set — that is the teeth of this check. */
const slashSource = read('webview-ui/src/slashCommands.ts');
const sidebar = new Set<string>(
  Array.from(slashSource.matchAll(/trigger: '([A-Za-z][A-Za-z0-9]*)'/gu), (m) => m[1]!),
);

/** Telegram: the published help inventory, plus every command literal the
 *  remote surface carries (`/pair` is pairing, `/list` and `/select` are chat
 *  aliases that help does not repeat). */
const remote = new Set<string>(
  Array.from(read('src/remote/remoteHelpText.ts').matchAll(/usage: '\/([a-z][A-Za-z0-9]*)'/gu), (m) =>
    m[1]!,
  ),
);
for (const name of fs.readdirSync(path.join(root, 'src', 'remote'))) {
  if (!name.endsWith('.ts')) continue;
  const source = read(path.join('src/remote', name));
  for (const match of source.matchAll(/'\/([a-z][A-Za-z0-9]+)'/gu)) remote.add(match[1] as string);
  // A command matched by a regular expression rather than a string literal:
  // `src/remote/RemoteAuth.ts:63` pairs on `/^\/pair ([0-9]{8})$/`, so `/pair`
  // is a command the owner types even though no source line says `'/pair'`.
  // Only a backslash-escaped slash counts, so a URL's `//segment` stays out.
  for (const match of source.matchAll(/\\\/([a-z][a-z0-9]+)/gu)) remote.add(match[1] as string);
}

/** Control-server routes: a doc naming `/ensure` or `/healthz` is naming an
 *  endpoint, not a command the reader types. */
const routes = new Set<string>();
for (const name of fs.readdirSync(path.join(root, 'src', 'backend'))) {
  if (!name.endsWith('.ts')) continue;
  for (const match of read(path.join('src/backend', name)).matchAll(
    /(?:path|route|pathname) === '\/([a-z][a-z0-9]+)'/gu,
  )) {
    routes.add(match[1] as string);
  }
}

/** The only hand-typed entries, each with the code that says why it is not a
 *  command a reader can type today. */
const EXCEPTIONS: Record<string, string> = {
  // `src/vscode/agentRouteDeps.ts:151-153` records that Telegram `/steer` was
  // removed; `docs/REMOTE_CONTROL.md:92` says so in the same words.
  steer: 'the withdrawn Telegram /steer (docs/REMOTE_CONTROL.md:92)',
  // BotFather's own commands, quoted from Telegram's UI, not Forge's:
  // `docs/TELEGRAM_QUICKSTART.md:23` and `AI_SETUP.md:261`.
  newbot: "BotFather's /newbot",
  revoke: "BotFather's /revoke",
  // `docs/OWNERS.md:45` is the internal owner map, which names a command by its
  // id: `unloadModel` is the id and `unload` is the trigger
  // (`webview-ui/src/slashCommands.ts:164-165`). It is not something a reader types.
  unloadModel: 'the owner-map id; the typed trigger is /unload',
};

const canonical = new Set<string>([...sidebar, ...remote, ...routes]);

describe('every command a doc tells a reader to type exists', () => {
  it('has inventories to compare against, so the check cannot pass by finding nothing', () => {
    expect(sidebar.size).toBeGreaterThan(20);
    expect(remote.size).toBeGreaterThan(30);
    expect(routes).toContain('ensure');
    expect(sidebar).toContain('restart');
    expect(claims.size).toBeGreaterThan(30);
    expect(claims.has('restart')).toBe(true);
  });

  it('names only commands the product handles', () => {
    const offenders = [...claims.entries()]
      .filter(([command]) => !canonical.has(command) && !EXCEPTIONS[command])
      .map(([command, files]) => `/${command} <- ${files.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('every bold palette entry is in the manifest', () => {
    const pkg = JSON.parse(read('package.json')) as {
      contributes: { commands: { title: string }[] };
    };
    const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();
    const titles = new Set(pkg.contributes.commands.map((command) => normalize(command.title)));
    const missing: string[] = [];
    for (const relative of sources) {
      for (const match of read(relative).matchAll(/\*\*Forge: ([^*]+?)\*\*/gu)) {
        const claim = normalize(`Forge: ${match[1] ?? ''}`);
        if (!titles.has(claim)) missing.push(`${relative}: ${claim}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
