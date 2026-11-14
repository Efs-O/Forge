import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SEARCH_EXCLUDES,
  exclusionsCoveringRoot,
  namedExistingPath,
  resolveSearchCodeScope,
  rgScopeArgs,
} from '../../src/tools/searchScope';
import { SNIPPETS_PER_FILE_LIMIT } from '../../src/tools/searchCodeTool';
import { searchCodeRgArgs, type SearchCodeOptions } from '../../src/tools/searchCodeCrawl';

describe('grep_search excludes', () => {
  // Bare `.git/**` is anchored to the search root, so a monorepo's
  // `subproject/.git/` and `subproject/node_modules/` were searched anyway.
  // `find_files` always excluded these recursively, so the two tools disagreed
  // about what is in the workspace.
  it('excludes every noise directory recursively, not just at the root', () => {
    for (const dir of ['.git', 'node_modules', 'dist', 'out']) {
      expect(SEARCH_EXCLUDES).toContain(`!**/${dir}/**`);
    }
  });

  // .forge/embeddings.index.json is a verbatim copy of every indexed chunk, so
  // it matches nearly any query — and being a dot-directory it sorts first, so
  // it spent the whole output budget before a single real source file rendered.
  it('excludes the .forge index, which mirrors the sources it would shadow', () => {
    expect(SEARCH_EXCLUDES).toContain('!**/.forge/embeddings.index.json');
  });

  // But NOT the whole directory. Excluding `.forge/**` also hid config.yaml,
  // the most-edited file in this workspace: grep_search reported "no matches"
  // for `num_ctx` in a file holding dozens of them.
  it('does not exclude .forge wholesale, which would hide config.yaml', () => {
    expect(SEARCH_EXCLUDES).not.toContain('!**/.forge/**');
    expect(SEARCH_EXCLUDES.some((glob) => glob.includes('config.yaml'))).toBe(false);
  });

  // A per-file cap is what stops any single noisy file from starving the rest,
  // whether or not it is one we thought to exclude.
  it('caps snippets per file so one file cannot consume the whole result', () => {
    expect(SNIPPETS_PER_FILE_LIMIT).toBeGreaterThan(0);
    expect(SNIPPETS_PER_FILE_LIMIT).toBeLessThan(50);
  });
});

describe('searchCodeRgArgs', () => {
  const root = path.resolve(__dirname, '..', '..');
  const argsFor = (over: Partial<SearchCodeOptions> = {}): string[] =>
    searchCodeRgArgs(
      {
        query: 'needle',
        literal: false,
        include: '**/*',
        maxResults: 20,
        offset: 0,
        output: 'content',
        context: 2,
        ignoreCase: false,
        ...over,
      },
      resolveSearchCodeScope(over.include ?? '**/*', root),
    );

  // 1,164 shell greps in the audit window carried -A/-B most of the time, and
  // the tool could only ever answer two lines. One number, because before/after
  // is two numbers for a local model to get wrong.
  it('asks ripgrep for the context the caller named', () => {
    expect(argsFor()).toEqual(expect.arrayContaining(['--context', '2']));
    expect(argsFor({ context: 0 })).toEqual(expect.arrayContaining(['--context', '0']));
    expect(argsFor({ context: 7 })).toEqual(expect.arrayContaining(['--context', '7']));
  });

  // A path or count list prints no lines, so context is not merely unused there:
  // ripgrep would print lines the tool throws away, doubling the crawl's work
  // for the cheapest answer it gives.
  it('sends no context to ripgrep for a path or count list, whatever was asked', () => {
    expect(argsFor({ output: 'files', context: 5 })).toEqual(
      expect.arrayContaining(['--context', '0']),
    );
    expect(argsFor({ output: 'count', context: 5 })).toEqual(
      expect.arrayContaining(['--context', '0']),
    );
  });

  // `-i` was the other common flag. Sent unconditionally it would have made
  // every search case-blind, which is not what a search for an identifier means.
  it('sends --ignore-case only when the caller asked for it', () => {
    expect(argsFor({ ignoreCase: true })).toContain('--ignore-case');
    expect(argsFor()).not.toContain('--ignore-case');
  });

  it('keeps the complete default glob argv free of --no-ignore-vcs', () => {
    expect(argsFor()).toEqual([
      '--json',
      '--line-number',
      '--with-filename',
      '--context',
      '2',
      '--hidden',
      '--glob',
      '**/*',
      ...SEARCH_EXCLUDES.flatMap((glob) => ['--glob', glob]),
      '--regexp',
      'needle',
      '.',
    ]);
  });

  it('adds one --no-ignore-vcs for a glob only when include_ignored is true', () => {
    expect(argsFor({ include: 'src/**/*.ts', includeIgnored: true })).toEqual([
      '--json',
      '--line-number',
      '--with-filename',
      '--context',
      '2',
      '--hidden',
      '--glob',
      'src/**/*.ts',
      ...SEARCH_EXCLUDES.flatMap((glob) => ['--glob', glob]),
      '--no-ignore-vcs',
      '--regexp',
      'needle',
      '.',
    ]);
  });

  it('keeps tool exclusions and emits exactly one ignore override for named directories', () => {
    for (const includeIgnored of [false, true]) {
      const args = argsFor({ include: 'src', includeIgnored });
      expect(args.filter((arg) => arg === '--no-ignore-vcs')).toHaveLength(1);
      expect(args).toContain('!**/node_modules/**');
    }
  });

  it('sends --fixed-strings for a literal query and plain regex otherwise', () => {
    expect(argsFor({ literal: true })).toContain('--fixed-strings');
    expect(argsFor()).not.toContain('--fixed-strings');
  });

  // The `--new` failure: a query that begins with dashes reached ripgrep as a
  // flag and the search died before it started.
  it('puts --regexp immediately before the query, so a query is never read as a flag', () => {
    const args = argsFor({ query: '--new' });
    const at = args.indexOf('--regexp');
    expect(args[at + 1]).toBe('--new');
    expect(args[at + 2]).toBe('.');
    expect(args.indexOf('--new')).toBe(at + 1);
  });

  it('carries the caller glob and every exclusion beside the new flags', () => {
    const args = argsFor({ include: 'src/**/*.ts', ignoreCase: true });
    expect(args).toContain('--glob');
    expect(args.slice(args.indexOf('--glob') + 1)).toContain('src/**/*.ts');
    for (const glob of SEARCH_EXCLUDES) expect(args).toContain(glob);
  });
});

describe('namedExistingPath', () => {
  // This repo's own tree: `.gitignore` lists `.forge/`, so ripgrep skips it
  // while crawling. Naming the file makes it a search root instead, which
  // ignore rules do not filter.
  const root = path.resolve(__dirname, '..', '..');

  it('resolves a gitignored file the caller named in full', () => {
    expect(namedExistingPath('package.json', root)).toBe('package.json');
  });

  it('leaves wildcard patterns alone so ignore rules still apply', () => {
    expect(namedExistingPath('src/**/*.ts', root)).toBeUndefined();
    expect(namedExistingPath('.forge/**', root)).toBeUndefined();
  });

  it('refuses a path that does not exist', () => {
    expect(namedExistingPath('nope/does-not-exist.txt', root)).toBeUndefined();
  });

  it('refuses to escape the workspace or to be read as a flag', () => {
    expect(namedExistingPath('../package.json', root)).toBeUndefined();
    expect(namedExistingPath('--files', root)).toBeUndefined();
  });

  it('reports workspace-relative with forward slashes', () => {
    expect(namedExistingPath('src/tools/searchScope.ts', root)).toBe('src/tools/searchScope.ts');
  });
});

describe('resolveSearchCodeScope', () => {
  const root = path.resolve(__dirname, '..', '..');
  const forward = (value: string): string => value.replace(/\\/gu, '/');

  it('keeps relative globs rooted at the workspace', () => {
    expect(resolveSearchCodeScope('src/**/*.ts', root)).toEqual({
      target: '.',
      glob: 'src/**/*.ts',
      explicitPath: false,
      applyExcludes: true,
      rootDir: forward(root),
    });
  });

  it('records the directory a named relative path is searched from', () => {
    expect(resolveSearchCodeScope('src', root).rootDir).toBe(forward(path.join(root, 'src')));
  });

  it('allows an explicitly named absolute file outside the workspace', () => {
    const externalFile = path.join(os.tmpdir(), `forge-search-${process.pid}.txt`);
    fs.writeFileSync(externalFile, 'needle');
    try {
      expect(resolveSearchCodeScope(externalFile, root)).toEqual({
        target: externalFile,
        explicitPath: true,
        applyExcludes: false,
        // A file is searched as its own path, and the recorded root is the folder
        // it sits in, because that is what an exclusion has to be asked against.
        rootDir: forward(path.dirname(externalFile)),
      });
    } finally {
      fs.rmSync(externalFile, { force: true });
    }
  });

  it('allows an explicitly named absolute directory outside the workspace', () => {
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-search-scope-'));
    try {
      expect(resolveSearchCodeScope(externalRoot, root)).toEqual({
        target: externalRoot,
        explicitPath: true,
        applyExcludes: true,
        rootDir: forward(externalRoot),
      });
    } finally {
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('roots absolute globs at their static directory prefix', () => {
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-search-scope-'));
    try {
      expect(resolveSearchCodeScope(path.join(externalRoot, '**', '*.py'), root)).toEqual({
        target: externalRoot,
        glob: '**/*.py',
        explicitPath: false,
        applyExcludes: true,
        rootDir: forward(externalRoot),
      });
    } finally {
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('does not fall back to the workspace for a missing absolute target', () => {
    expect(() =>
      resolveSearchCodeScope(path.join(os.tmpdir(), `missing-${process.pid}.py`), root),
    ).toThrow('grep_search: absolute include path does not exist');
  });

  // `N:\*` and `C:\*` derived the rg root from the empty static prefix, i.e. the
  // whole drive, and `--hidden` then crawled every mapped share (audit F1).
  it('refuses an absolute glob whose static prefix is the drive root', () => {
    const driveRoot = path.parse(root).root;
    expect(() => resolveSearchCodeScope(path.join(driveRoot, '*'), root)).toThrow(
      'must name a directory below the drive root',
    );
    expect(() => resolveSearchCodeScope(path.join(driveRoot, '**', '*.ts'), root)).toThrow(
      'must name a directory below the drive root',
    );
  });

  it('keeps a wildcard one directory below the drive root', () => {
    const driveRoot = path.parse(root).root;
    const nested = path.join(driveRoot, 'nonexistent-forge-scope-test');
    expect(() => resolveSearchCodeScope(path.join(nested, '**', '*.ts'), root)).toThrow(
      'absolute include root does not exist',
    );
  });

  it('reports a named directory as a directory, not as a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-scope-dir-'));
    try {
      expect(resolveSearchCodeScope(dir, root)).toEqual({
        target: dir,
        explicitPath: true,
        applyExcludes: true,
        rootDir: forward(dir),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rgScopeArgs', () => {
  const root = path.resolve(__dirname, '..', '..');

  // The bug: `explicitPath` drove BOTH `--no-ignore-vcs` and the loss of the
  // exclusion list, so naming the workspace root (which the new tool description
  // invites) crawled node_modules, dist, .git and the embeddings index — the
  // exact failure SEARCH_EXCLUDES exists to prevent (audit F1, 2026-10-03).
  it('keeps every exclusion when the caller names a directory', () => {
    const args = rgScopeArgs(resolveSearchCodeScope(root, root));
    expect(args).toContain('--no-ignore-vcs');
    for (const dir of ['.git', 'node_modules', 'dist', 'out']) {
      expect(args).toContain(`!**/${dir}/**`);
    }
  });

  it('keeps every exclusion for a named relative directory', () => {
    const args = rgScopeArgs(resolveSearchCodeScope('src', root));
    expect(args).toContain('--no-ignore-vcs');
    for (const glob of SEARCH_EXCLUDES) expect(args).toContain(glob);
  });

  it('keeps the caller glob plus the exclusions for a wildcard include', () => {
    const args = rgScopeArgs(resolveSearchCodeScope('src/**/*.ts', root));
    expect(args).toEqual([
      '--glob',
      'src/**/*.ts',
      ...SEARCH_EXCLUDES.flatMap((glob) => ['--glob', glob]),
    ]);
  });

  it('drops the exclusions only for a named FILE, which is the point of naming it', () => {
    const args = rgScopeArgs(resolveSearchCodeScope('config/config.example.yaml', root));
    expect(args).toEqual(['--no-ignore-vcs']);
  });

  it('sends no --glob naming the path itself, which would filter out the path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-scope-args-'));
    try {
      const args = rgScopeArgs(resolveSearchCodeScope(dir, root));
      const globs = args.filter((_, i) => args[i - 1] === '--glob');
      expect(globs).not.toContain(dir);
      expect(globs).not.toContain(dir.replace(/\\/gu, '/'));
      // Every --glob present is one of the exclusions, and nothing else.
      expect(globs).toEqual(SEARCH_EXCLUDES);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a search rooted inside one of the exclusions', () => {
  const root = path.resolve(__dirname, '..', '..');
  const forward = (value: string): string => value.replace(/\\/gu, '/');
  /** A folder outside the workspace whose name has a space in it, holding a
   *  `.forge/sessions` subfolder — the shape of the owner's real session logs, and
   *  the shape that made the answer wrong twice: a space breaks nothing in the
   *  resolver, but the exclusion prunes the folder the caller named. */
  function outsideSessions(): { base: string; sessions: string } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge search inside-'));
    const sessions = path.join(base, '.forge', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, 'a.jsonl'), 'session_start {"role":"user"}\n');
    return { base, sessions };
  }
  const globsIn = (args: string[]): string[] =>
    args.filter((_, index) => args[index - 1] === '--glob');

  // The false answer this fixes: `include` named the session-log folder, the
  // exclusion list prunes `.forge/sessions/`, and the tool reported "No matches
  // found" for `session_start` — text every session log begins with. A tool that
  // reports absence for files it never opened is worse than one that refuses.
  it('drops the exclusion that would prune the folder the caller named', () => {
    const { base, sessions } = outsideSessions();
    try {
      const scope = resolveSearchCodeScope(sessions, root);
      expect(scope.rootDir).toBe(forward(sessions));
      const args = rgScopeArgs(scope);
      expect(globsIn(args)).not.toContain('!**/.forge/sessions/**');
      // Only the rule that prunes the root is dropped: the rest still keeps
      // node_modules, dist and .git out of a crawl of that folder.
      expect(globsIn(args)).toContain('!**/.git/**');
      expect(globsIn(args)).toContain('!**/node_modules/**');
      expect(args).toContain('--no-ignore-vcs');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('keeps the exclusion for a search rooted above it', () => {
    const { base, sessions } = outsideSessions();
    try {
      const scope = resolveSearchCodeScope(path.join(base, '**', '*.jsonl'), root);
      expect(globsIn(rgScopeArgs(scope))).toContain('!**/.forge/sessions/**');
      // And the deeper root inside the same exclusion drops it, which is the same
      // rule at one level down.
      const deep = resolveSearchCodeScope(path.join(sessions, '**', '*.jsonl'), root);
      expect(globsIn(rgScopeArgs(deep))).not.toContain('!**/.forge/sessions/**');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('names which rule was dropped and which root made it drop', () => {
    const { base, sessions } = outsideSessions();
    try {
      const covering = exclusionsCoveringRoot(forward(sessions));
      expect(covering.dropped).toEqual(['!**/.forge/sessions/**']);
      expect(covering.keep).toContain('!**/.git/**');
      expect(covering.keep).toContain('!**/.forge/embeddings.index.json');
      // A search rooted at the workspace, or at the `.forge` folder itself, prunes
      // nothing: `sessions/` is below those roots, not part of their names, so
      // `.forge/config.yaml` is still searched while the logs under it are not.
      expect(exclusionsCoveringRoot(forward(root)).dropped).toEqual([]);
      expect(exclusionsCoveringRoot(forward(path.join(root, '.forge'))).dropped).toEqual([]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not read a file exclusion as a pruned directory', () => {
    // `!**/.forge/embeddings.index.json` names one file. A directory root can be
    // inside a pruned DIRECTORY but never inside a pruned FILE, so this glob is
    // kept for every root — otherwise naming the index folder would switch the
    // duplicate-match guard off.
    const covering = exclusionsCoveringRoot(
      path.join(root, '.forge', 'embeddings.index.json').replace(/\\/gu, '/').replace(/\/[^/]*$/u, ''),
    );
    expect(covering.dropped).toEqual([]);
    expect(covering.keep).toContain('!**/.forge/embeddings.index.json');
  });
});
