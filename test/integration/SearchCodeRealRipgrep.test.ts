import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSearchCodeTool } from '../../src/tools/searchCodeTool';
import { resolveRipgrep } from '../../src/tools/RipgrepResolver';
import { resolveLiveAppRoot } from '../live/liveModelHarness';
import { removeTreeWhenFree } from '../support/removeTempTree';

/**
 * The fake-rg argv assertions prove the tool SENDS the exclusions; this proves
 * real ripgrep AGREES with them. Skipped unless a ripgrep binary actually
 * exists on disk — a CI runner may have `code` on PATH but no unpacked rg, and
 * `resolveRipgrep` then falls back to the bare name, which would fail here for
 * the wrong reason (audit F1 follow-up, Codex review, 2026-10-03).
 */
const bundledRg = resolveRipgrep(resolveLiveAppRoot());
const realRg = fs.existsSync(bundledRg.command) ? bundledRg : undefined;
let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

describe.skipIf(realRg === undefined || !gitAvailable)(
  'grep_search against the bundled ripgrep',
  () => {
    let root: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-search-real-'));
      execFileSync('git', ['init', '-q'], { cwd: root });
      vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
      fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
      for (const [file, text] of [
        ['keep.ts', 'needle here'],
        ['node_modules/pkg/a.txt', 'needle'],
        ['dist/bundle.js', 'needle here'],
        ['.git/COMMIT_EDITMSG', 'needle here'],
        ['ignored/a.txt', 'needle'],
      ] as const) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
      }
    });

    afterEach(async () => {
      vscode.workspace.workspaceFolders.splice(0);
      // A cancelled search rejects before the killed child (cwd = root) has
      // exited, and Windows refuses to remove a directory a process sits in.
      await removeTreeWhenFree(root);
    });

    function tool() {
      return makeSearchCodeTool(() => realRg!);
    }

    it('skips a gitignored path for a narrow glob unless include_ignored is true', async () => {
      const missed = await tool().handler({ query: 'needle', include: '**/*.txt' });
      expect(missed).toBe(
        'No matches found for "needle" in **/*.txt ' +
          '(ripgrep-regex search (relative include globs are anchored at the workspace root)).' +
          ' A glob can skip gitignored files; set include_ignored: true to search them. The tool also keeps ' +
          '`!**/.git/**`, `!**/node_modules/**`, `!**/dist/**`, `!**/out/**`, ' +
          '`!**/.forge/embeddings.index.json`, `!**/.forge/sessions/**`, `!**/.forge/remote-inbox/**` ' +
          'out of a crawl — name the file or folder in full in `include` to search inside one.',
      );
      const found = await tool().handler({
        query: 'needle',
        include: '**/*.txt',
        include_ignored: true,
      });
      expect(found).toContain('=== ignored/a.txt ===');
      expect(found).toContain('> 1: needle');
      expect(found).not.toContain('node_modules');
    });

    it('lets a broad positive glob reach a gitignored path without the flag', async () => {
      // Ripgrep's positive glob overrides ignore files when it matches the
      // ignored folder itself; the note says “can” so it remains accurate here.
      const found = await tool().handler({ query: 'needle', include: '**/*' });
      expect(found).toContain('=== ignored/a.txt ===');
      expect(found).not.toContain('node_modules');
    });

    // The F1 failure itself: naming the workspace root used to drop every
    // exclusion, so this returned node_modules, dist and .git matches.
    it('omits noise directories when the caller names the workspace root', async () => {
      const result = await tool().handler({ query: 'needle here', include: root });
      expect(result).toContain('keep.ts');
      expect(result).not.toContain('node_modules');
      expect(result).not.toContain('bundle.js');
      expect(result).not.toContain('COMMIT_EDITMSG');
    });

    it('still searches a deliberately named file inside an excluded directory', async () => {
      // Naming `dist/bundle.js` in full is an explicit request for THAT file —
      // rgScopeArgs drops the exclusions exactly here, and this is the proof the
      // exception is not over-broad in the other direction.
      const named = path.join(root, 'dist', 'bundle.js');
      const result = await tool().handler({ query: 'needle here', include: named });
      expect(result).toContain('bundle.js');
      expect(result).toContain('needle here');
    });

    it('omits noise directories for a relative wildcard include', async () => {
      const result = await tool().handler({ query: 'needle here', include: '**/*' });
      expect(result).toContain('keep.ts');
      expect(result).not.toContain('node_modules');
      expect(result).not.toContain('bundle.js');
    });

    // What the modes look like against the real binary, since the fake answers
    // every question with the events the tool asked for and cannot itself prove
    // that `--ignore-case` or `--context` means what the flag says it means.
    it('lists paths only for output "files"', async () => {
      const result = await tool().handler({
        query: 'needle here',
        include: '**/*',
        output: 'files',
      });
      expect(result).toBe('keep.ts');
    });

    it('counts matching lines per file for output "count"', async () => {
      fs.writeFileSync(path.join(root, 'many.ts'), 'needle here\nneedle here again\nplain\n');
      const result = await tool().handler({ query: 'needle', include: '**/*', output: 'count' });
      expect(result).toContain('many.ts:2');
      expect(result).toContain('keep.ts:1');
    });

    it('prints match lines only for context 0 and the lines beside them for context 1', async () => {
      fs.writeFileSync(path.join(root, 'around.ts'), 'before\nneedle here\nafter\n');
      const narrow = await tool().handler({ query: 'needle here', include: '**/*.ts', context: 0 });
      expect(narrow).toContain('> 2: needle here');
      expect(narrow).not.toContain('before');
      expect(narrow).not.toContain('after');

      const wide = await tool().handler({
        query: 'needle here',
        include: '**/*.ts',
        context: 1,
      });
      expect(wide).toContain('  1: before');
      expect(wide).toContain('  3: after');
    });

    it('matches case-insensitively when ignore_case is set', async () => {
      fs.writeFileSync(path.join(root, 'case.ts'), 'NEEDLE HERE once\n');
      const folded = await tool().handler({
        query: 'needle here',
        include: '**/*.ts',
        ignore_case: true,
      });
      expect(folded).toContain('case.ts');
      expect(folded).toContain('NEEDLE HERE once');

      const exact = await tool().handler({ query: 'needle here', include: '**/*.ts' });
      expect(exact).not.toContain('case.ts');
    });

    it('matches ripgrep regex by default', async () => {
      fs.writeFileSync(path.join(root, 'heal.ts'), 'target.heal(value);');
      const result = await tool().handler({ query: String.raw`\.heal\(` });
      expect(result).toContain('heal.ts');
      expect(result).toContain('target.heal(value);');
    });

    it('matches punctuation literally when literal is true', async () => {
      fs.writeFileSync(path.join(root, 'literal.ts'), 'call foo(value);');
      const result = await tool().handler({ query: 'foo(', literal: true });
      expect(result).toContain('literal.ts');
    });

    it('returns invalid regex guidance as a tool result', async () => {
      const result = await tool().handler({ query: '[' });
      expect(result).toContain('regex parse error');
      expect(result).toContain('Escape the special characters, or retry with literal: true.');
    });

    it('names the regex mode in the no-match result', async () => {
      const result = await tool().handler({ query: 'no-such-pattern' });
      expect(result).toContain('(ripgrep-regex search');
    });

    // The false answer from 2026-11-02: `include` named the folder that holds the
    // session logs, the tool's own noise list prunes `.forge/sessions/`, and real
    // ripgrep matched nothing because every file under the search root was pruned.
    // The agent believed the text was absent and stopped looking. A search that
    // drops or applies a rule has to say which, so "no matches" cannot be read as
    // absence without knowing what was opened.
    it('searches a folder outside the workspace whose path has a space in it', async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge search space-'));
      const sessions = path.join(base, '.forge', 'sessions');
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, 'a.jsonl'), 'session_start {"role":"user"}\n');
      try {
        const byFolder = await tool().handler({
          query: 'session_start',
          include: sessions,
          output: 'files',
        });
        expect(byFolder, 'the folder it named was searched').toContain('a.jsonl');
        expect(byFolder).not.toContain('No matches found');
        // The same folder as a glob, which is the spelling that also failed.
        const byGlob = await tool().handler({
          query: 'session_start',
          include: path.join(sessions, '*.jsonl'),
          output: 'files',
        });
        expect(byGlob).toContain('a.jsonl');
        expect(byGlob).not.toContain('No matches found');
        // A search rooted ABOVE the pruned folder still prunes it, so the fix is not
        // "never exclude" — it is "do not prune the folder the caller named". And the
        // miss has to name the rules that did the pruning, because "no matches" for
        // a folder that was never opened is the false answer this whole change is
        // about.
        const above = await tool().handler({
          query: 'session_start',
          include: path.join(base, '**', '*.jsonl'),
          output: 'files',
        });
        expect(above).toContain('No matches found');
        expect(above).toContain('The tool also keeps');
        expect(above).toContain('!**/.forge/sessions/**');
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it('searches that folder named with forward slashes, as the 11-02 agent wrote it', async () => {
      if (process.platform !== 'win32') return;
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge search back-'));
      const sessions = path.join(base, '.forge', 'sessions');
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, 'a.jsonl'), 'session_start {"role":"user"}\n');
      try {
        const result = await tool().handler({
          query: 'session_start',
          // `C:/Users/…` is the spelling the 11-02 agent sent; `path.join` gives the
          // backslashed one, so this call is the other dialect of the same request.
          include: sessions.split(path.sep).join('/'),
          output: 'files',
        });
        expect(result).toContain('a.jsonl');
        expect(result).not.toContain('No matches found');
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  },
);
