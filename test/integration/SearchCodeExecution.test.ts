import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSearchCodeTool } from '../../src/tools/searchCodeTool';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import {
  clearConversationSecretState,
  hasConversationReadSecret,
} from '../../src/tools/exfilTaint';
import { removeTreeWhenFree } from '../support/removeTempTree';
import type { ForgeConfig } from '../../src/config/types';

describe('isolated grep_search process execution', () => {
  let root: string;
  const fixture = path.resolve(__dirname, '../fixtures/fake-rg.mjs');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-search-code-'));
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });

  afterEach(async () => {
    vscode.workspace.workspaceFolders.splice(0);
    // A cancelled search rejects before the killed child (cwd = root) has
    // exited, and Windows refuses to remove a directory a process sits in.
    await removeTreeWhenFree(root);
  });

  function tool() {
    return makeSearchCodeTool(() => ({
      command: process.execPath,
      argsPrefix: [fixture],
      candidates: [fixture],
    }));
  }

  /** The same fake ripgrep with the secret gate's own home and case rules. */
  function gated() {
    return makeSearchCodeTool(
      () => ({ command: process.execPath, argsPrefix: [fixture], candidates: [fixture] }),
      { home: '/home/forge-test', platform: 'linux' },
    );
  }

  it('spawns the resolved command, parses JSON events, and enforces the file-result limit', async () => {
    const result = await tool().handler({
      query: 'known fixture',
      include: '**/*.ts',
      max_results: 1,
    });
    expect(result).toContain('=== first.ts ===');
    expect(result).toContain('> 2: known fixture');
    expect(result).not.toContain('second.ts');
    // A full page used to read the same whether more files matched or none did,
    // so an agent that assumed "20" meant "all" reported absence for something
    // present. The limit and the continuation are now said apart (item 1.1).
    expect(result).toContain('call again with offset 1');
  });

  // The schema is what the model is asked to fill in; four new fields that only
  // the handler honoured would let a backend send nothing at all.
  it('advertises the output modes, context, case and offset it accepts', () => {
    const properties = tool().definition.function.parameters?.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties['output']).toMatchObject({
      type: 'string',
      enum: ['content', 'files', 'count'],
    });
    // No declared bounds on `context`, on purpose: an out-of-range value is clamped by
    // the tool and named in the result, not refused by the shared validator.
    expect(properties['context']).toMatchObject({ type: 'integer' });
    expect(properties['context']).not.toHaveProperty('minimum');
    expect(properties['context']).not.toHaveProperty('maximum');
    expect(String(properties['context']?.['description'])).toContain('More is clamped to 30');
    expect(properties['ignore_case']).toMatchObject({ type: 'boolean' });
    expect(properties['include_ignored']).toEqual({
      type: 'boolean',
      description:
        "Also search files the workspace .gitignore excludes (default false). A broad glob such as **/* can already reach them; set this to be sure. The tool's own exclusions (.git, node_modules, dist, out, Forge's embeddings index, session logs, remote inbox) still apply.",
    });
    expect(properties['offset']).toMatchObject({ type: 'integer', minimum: 0 });
    expect(tool().definition.function.parameters).toMatchObject({ additionalProperties: false });
  });

  it('uses the registry boolean coercion for include_ignored before dispatch', async () => {
    const registered = tool();
    const registry = new ToolRegistry();
    registry.register(registered);
    const args: Record<string, unknown> = {
      query: 'args fixture',
      include: '**/*.ts',
      include_ignored: 'True',
    };
    expect(registry.invalidArgs(registered, args)).toBeUndefined();
    expect(args['include_ignored']).toBe(true);
    const result = await registry.dispatch('grep_search', args, new Set(['read']));
    expect(result).toContain('--no-ignore-vcs');
  });

  it('returns the complete false-case gitignore note on a glob miss', async () => {
    const result = await tool().handler({ query: 'case fixture', include: '**/*.ts' });
    expect(result).toBe(
      'No matches found for "case fixture" in **/*.ts ' +
        '(ripgrep-regex search (relative include globs are anchored at the workspace root)).' +
        ' A glob can skip gitignored files; set include_ignored: true to search them. The tool also keeps ' +
        '`!**/.git/**`, `!**/node_modules/**`, `!**/dist/**`, `!**/out/**`, ' +
        '`!**/.forge/embeddings.index.json`, `!**/.forge/sessions/**`, `!**/.forge/remote-inbox/**` ' +
        'out of a crawl — name the file or folder in full in `include` to search inside one.',
    );
  });

  it('returns the complete true-case gitignore note on a glob miss', async () => {
    const result = await tool().handler({
      query: 'case fixture',
      include: '**/*.ts',
      include_ignored: true,
    });
    expect(result).toBe(
      'No matches found for "case fixture" in **/*.ts ' +
        '(ripgrep-regex search (relative include globs are anchored at the workspace root)).' +
        ' Gitignored files were searched. The tool still keeps ' +
        '`!**/.git/**`, `!**/node_modules/**`, `!**/dist/**`, `!**/out/**`, ' +
        '`!**/.forge/embeddings.index.json`, `!**/.forge/sessions/**`, `!**/.forge/remote-inbox/**` ' +
        'out of a crawl — name the file or folder in full in `include` to search inside one.',
    );
  });

  // 1,164 shell greps in the audit window; the common flags were -n, -l, -c and
  // -i. "Where should I look next" is answered by paths, not by their contents.
  it('output "files" lists paths only, with no header, snippet or line number', async () => {
    const result = await tool().handler({
      query: 'known fixture',
      include: '**/*.ts',
      output: 'files',
      max_results: 3,
    });
    expect(result).toBe('first.ts\nsecond.ts');
  });

  it('output "count" gives the real per-file counts, not the ones the snippet cap kept', async () => {
    const result = await tool().handler({
      query: 'count fixture',
      include: '**/*.ts',
      output: 'count',
      max_results: 3,
    });
    expect(result).toBe('a.ts:3\nb.ts:2\nc.ts:1');
  });

  // The page limit stops the crawl, and a count that stopped with it would say
  // "1" for the last file in the page. The crawl sees that file's every match
  // before it sees the next file's first, so the number is the true one.
  it('counts the last file in a page in full and names the offset that continues', async () => {
    const result = await tool().handler({
      query: 'count fixture',
      include: '**/*.ts',
      output: 'count',
      max_results: 2,
    });
    expect(result).toContain('a.ts:3');
    expect(result).toContain('b.ts:2');
    expect(result).not.toContain('c.ts');
    expect(result).toContain('call again with offset 2');
  });

  // The same two facts, with the events arriving one at a time instead of all
  // in one stdout chunk. Without the pause the fake cannot tell a crawl that
  // stops at "the page is full" from one that stops at "a file beyond the page":
  // both see the rest of the buffered chunk, so both pass, and only the second
  // one is right against a ripgrep that streams a large tree.
  it('counts the last file in the page in full when events stream in apart', async () => {
    const streaming = makeSearchCodeTool(() => ({
      command: process.execPath,
      argsPrefix: [fixture, '--flush'],
      candidates: [fixture],
    }));
    const result = await streaming.handler({
      query: 'count fixture',
      include: '**/*.ts',
      output: 'count',
      max_results: 1,
    });
    // The page holds one file, and that file's count is its real three matches,
    // not the one line the crawl had seen when it decided the page was full.
    expect(result).toContain('a.ts:3');
    expect(result).not.toContain('a.ts:1');
    // And the next file's first line is what proves more remain: the note is
    // there because a file was seen, not because a chunk happened to be large.
    expect(result).toContain('call again with offset 1');
  });

  // The other half of the same decision: one file in the tree and the page full
  // is the end of the search, and a crawl that kills on "page is full" cannot
  // tell that from "twenty of a hundred" — it used to say "matched N files in
  // total" for one and name an offset for the other, by accident of buffering.
  it('does not promise another page when the page ended with the search', async () => {
    const streaming = makeSearchCodeTool(() => ({
      command: process.execPath,
      argsPrefix: [fixture, '--flush'],
      candidates: [fixture],
    }));
    const result = await streaming.handler({
      query: 'single fixture',
      include: '**/*.ts',
      output: 'count',
      max_results: 1,
    });
    expect(result).toBe('only.ts:3');
    expect(result).not.toContain('call again with offset');
  });

  // One number for before and after, not two: a local model has to fill this in
  // correctly on the first try, and `-A`/`-B` is two numbers to get wrong.
  it('context 0 prints match lines only and context 2 prints the lines around them', async () => {
    const narrow = await tool().handler({
      query: 'context fixture',
      include: '**/*.ts',
      context: 0,
    });
    expect(narrow).toContain('> 1: hit one');
    expect(narrow).toContain('> 4: hit two');
    expect(narrow).not.toContain('ctx 2');

    const wide = await tool().handler({
      query: 'context fixture',
      include: '**/*.ts',
      context: 2,
    });
    expect(wide).toContain('  2: ctx 2');
    expect(wide).toContain('  3: ctx 3');
    expect(wide).toContain('  5: ctx 5');
  });

  // The flag is what the model asked for, proven on the argv ripgrep actually
  // received, the same way the exclusion-argv test proves the scope flags. The
  // path modes' forced `--context 0` is asserted in `SearchCodeExcludes.test.ts`
  // against `searchCodeRgArgs`, because a path list prints no line text for the
  // fake's echo to show up in.
  it('sends --context and --ignore-case to ripgrep as the call asked', async () => {
    const asked = await tool().handler({
      query: 'flag fixture',
      include: '**/*.ts',
      context: 4,
      ignore_case: true,
    });
    expect(asked).toContain('--context 4');
    expect(asked).toContain('--ignore-case');

    const defaulted = await tool().handler({ query: 'flag fixture', include: '**/*.ts' });
    expect(defaulted).toContain('--context 2');
    expect(defaulted).toContain('--case-sensitive');
  });

  // A caller that wants more context than this tool carries is not wrong about what it
  // wants, only about how much is available. Refusing it spent 20 rounds across 10 days
  // of session logs to re-send a search that was about to run anyway, so the ask is
  // clamped and the result names the number it actually got.
  it('clamps a context ask above the ceiling and says so instead of refusing it', async () => {
    const asked = await tool().handler({
      query: 'flag fixture',
      include: '**/*.ts',
      context: 400,
    });
    expect(asked).toContain('--context 30');
    expect(asked).toContain('asked for 400 lines');
    expect(asked).toContain('this tool carries 0-30');
  });

  it('carries a context ask inside the ceiling with no note about it', async () => {
    const asked = await tool().handler({
      query: 'flag fixture',
      include: '**/*.ts',
      context: 25,
    });
    expect(asked).toContain('--context 25');
    expect(asked).not.toContain('asked for');
  });

  it('clamps a context ask below zero to the match lines and says so', async () => {
    const asked = await tool().handler({
      query: 'flag fixture',
      include: '**/*.ts',
      context: -3,
    });
    expect(asked).toContain('--context 0');
    expect(asked).toContain('asked for -3 lines');
  });

  // Real ripgrep matches `NEEDLE` for `needle` only with --ignore-case, so the
  // fake answers the same way and the case test cannot pass on a flag the tool
  // never sent.
  it('ignore_case matches across case, and without it the same search finds nothing', async () => {
    const folded = await tool().handler({
      query: 'case fixture',
      include: '**/*.ts',
      ignore_case: true,
    });
    expect(folded).toContain('NEEDLE two');

    const exact = await tool().handler({ query: 'case fixture', include: '**/*.ts' });
    expect(exact).toContain('No matches found');
    expect(exact).not.toContain('NEEDLE two');
  });

  it('offset skips whole files and says so when the search has no more of them', async () => {
    const secondPage = await tool().handler({
      query: 'known fixture',
      include: '**/*.ts',
      output: 'files',
      offset: 1,
      max_results: 3,
    });
    expect(secondPage).toContain('second.ts');
    expect(secondPage).not.toContain('first.ts');
    expect(secondPage).toContain('matched 2 files in total');

    const pastTheEnd = await tool().handler({
      query: 'known fixture',
      include: '**/*.ts',
      offset: 5,
      max_results: 3,
    });
    expect(pastTheEnd).toContain('is past the end');
    expect(pastTheEnd).toContain('the last page starts at offset 0');
  });

  // The gate is the part that must not fork when the modes multiply: a path list
  // still names the secret file without printing what was in it.
  it('still drops secret hits from a files-mode search and says how many lines it hid', async () => {
    const result = await gated().handler({
      query: 'secret fixture',
      include: '**/*',
      output: 'files',
      max_results: 5,
    });
    expect(result).toContain('keep.ts');
    expect(result).not.toContain('API_KEY');
    expect(result).toContain('3 matching lines in 2 secret files');
    expect(result).toContain('read_file to ask the user');
  });

  it('refuses an output it does not have, naming the three it does', async () => {
    await expect(
      tool().handler({ query: 'known fixture', include: '**/*.ts', output: 'paths' }),
    ).rejects.toThrow('output must be "content", "files" or "count"');
  });

  // Qwen searched for `--new` twice and gave up: rg took the query for a flag.
  it('passes a query that starts with dashes as the pattern, not a flag', async () => {
    const result = await tool().handler({ query: '--new', include: '**/*.ts', max_results: 1 });
    expect(result).toContain('> 2: --new');
  });

  it('searches an explicitly named absolute file outside the workspace', async () => {
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-search-external-'));
    const externalFile = path.join(externalRoot, 'server.py');
    fs.writeFileSync(externalFile, 'fixture');
    try {
      const result = await tool().handler({ query: 'needle', include: externalFile });
      expect(result).toContain(`=== ${externalFile.replace(/\\/g, '/')} ===`);
      expect(result).toContain('> 2: needle');
    } finally {
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('searches an absolute glob under its external static directory', async () => {
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-search-external-'));
    try {
      const result = await tool().handler({
        query: 'needle',
        include: path.join(externalRoot, '**', '*.py'),
      });
      expect(result).toContain(
        `=== ${path.join(externalRoot, 'match.py').replace(/\\/g, '/')} ===`,
      );
      expect(result).toContain('> 2: needle');
    } finally {
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  // The exclusion list is what stops a search drowning in node_modules and the
  // embeddings index. The fixture used to ignore the glob arguments, so dropping
  // every one of them still passed (audit F1, 2026-10-03). Naming the workspace
  // root as an absolute path is the case that did exactly that.
  it('passes every exclusion when the caller names a directory', async () => {
    const result = await tool().handler({ query: 'args fixture', include: root });
    for (const glob of ['!**/.git/**', '!**/node_modules/**', '!**/dist/**', '!**/out/**']) {
      expect(result).toContain(glob);
    }
    expect(result).toContain('--no-ignore-vcs');
  });

  it('passes every exclusion for a relative wildcard include', async () => {
    const result = await tool().handler({ query: 'args fixture', include: '**/*.ts' });
    expect(result).toContain('!**/node_modules/**');
    expect(result).toContain('--glob **/*.ts');
    expect(result).not.toContain('--no-ignore-vcs');
  });

  it('says what it skipped when the tool dropped an exclusion to reach the folder named', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge search miss-'));
    const sessions = path.join(outside, '.forge', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    try {
      // `case fixture` is the query the fake answers with nothing at all unless
      // --ignore-case is sent, so this is the miss the note has to explain.
      const result = await tool().handler({ query: 'case fixture', include: sessions });
      expect(result).toContain('No matches found');
      expect(result).toContain('DROPPED');
      expect(result).toContain('!**/.forge/sessions/**');
      expect(result).toContain(sessions.replace(/\\/gu, '/'));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('says so when the include names a path that is not there, rather than a bare miss', async () => {
    const result = await tool().handler({ query: 'case fixture', include: 'nope/missing.ts' });
    expect(result).toContain('names one path exactly');
    expect(result).toContain('opened no file');
  });

  it('does not call an existing named file missing when it simply has no match', async () => {
    // The crawl is rooted AT a named file; judging the include against that
    // root doubled the path and reported a real file as not there.
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'present.md'), 'no hit here\n', 'utf8');
    const result = await tool().handler({ query: 'case fixture', include: 'docs/present.md' });
    expect(result).toContain('No matches');
    expect(result).not.toContain('names one path exactly');
    expect(result).not.toContain('opened no file');
  });

  it('kills the spawned search and reports caller cancellation', async () => {
    const controller = new AbortController();
    const pending = tool().handler(
      { query: 'slow fixture', include: '**/*.ts', max_results: 2 },
      { beforeMutate: () => undefined, abortSignal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toThrow('grep_search: cancelled');
  });

  it('includes resolved command diagnostics when process startup fails', async () => {
    const missing = makeSearchCodeTool(() => ({
      command: path.join(root, 'missing-rg'),
      candidates: [path.join(root, 'candidate-rg')],
    }));
    await expect(missing.handler({ query: 'fixture' })).rejects.toThrow(
      /failed to start ripgrep command.*candidate-rg/s,
    );
  });

  // The secret gate lives in the tool, not in ripgrep: the fixture prints lines
  // from `.env`, and the tool has to drop them and say how many it hid —
  // otherwise a search leaks a secret with no card and no trace (acceptance 3 of
  // docs/plans/EXFIL_GATES_PLAN.md).
  it('drops lines from secret files and reports how many it hid', async () => {
    const result = await gated().handler({ query: 'secret fixture', include: '**/*' });
    expect(result).toContain('keep.ts');
    expect(result).not.toContain('API_KEY');
    expect(result).not.toContain('postgres://secret');
    expect(result).toContain('3 matching lines in 2 secret files');
    expect(result).toContain('`.env` matched **/.env');
    expect(result).toContain('`sub/.env.local` matched **/.env.*');
    expect(result).toContain('read_file to ask the user');
  });

  // A search whose every hit was a secret file must not look like an empty
  // workspace: the agent would conclude the text is not there and stop looking.
  it('says so on the miss when every hit was a secret file', async () => {
    const result = await gated().handler({ query: 'only secret', include: '**/*' });
    expect(result).toContain('No matches outside secret paths');
    expect(result).toContain('2 matching lines in 1 secret file');
    expect(result).toContain('read_file to ask the user');
  });

  // Without the injected home and case the gate still applies: the defaults live
  // in code, so a tool registered with no config getter must not leak.
  it('still drops secret hits when no deps were passed', async () => {
    const result = await tool().handler({ query: 'secret fixture', include: '**/*' });
    expect(result).not.toContain('API_KEY');
    expect(result).toContain('matching lines in 2 secret files');
  });

  // The escape hatch again: a `.env` named in `permissions.secret_paths_allow`
  // gets no card and its lines are printed, so this chat has now read a secret
  // and pays for its next fetch (docs/plans/EXFIL_GATES_PLAN.md; case 5 of the
  // 2026-10-28 live security test). A hit that was hidden taints nothing — its
  // lines never reached the chat — so the two cases have to be tested apart.
  it('marks the chat whose allow-listed .env it printed', async () => {
    const resolve = () => ({
      command: process.execPath,
      argsPrefix: [fixture],
      candidates: [fixture],
    });
    const allowed = makeSearchCodeTool(resolve, {
      home: '/home/forge-test',
      platform: 'linux',
      getConfig: () =>
        ({ permissions: { secret_paths_allow: ['.env'] } }) as unknown as ForgeConfig,
    });
    const printed = await allowed.handler(
      { query: 'secret fixture', include: '**/*' },
      { beforeMutate: () => undefined, conversationId: 'search-allow' },
    );
    expect(printed).toContain('API_KEY=secret-value');
    expect(hasConversationReadSecret('search-allow')).toBe(true);
    // `sub/.env.local` was not on the allow list, so its line is still hidden —
    // and a hidden line marks nothing, which is the other half of this rule.
    expect(printed).not.toContain('OTHER=other');
    expect(printed).toContain('1 secret file');

    const hidden = await gated().handler(
      { query: 'secret fixture', include: '**/*' },
      { beforeMutate: () => undefined, conversationId: 'search-hidden' },
    );
    expect(hidden).not.toContain('API_KEY');
    expect(hasConversationReadSecret('search-hidden')).toBe(false);
    clearConversationSecretState();
  });
});
