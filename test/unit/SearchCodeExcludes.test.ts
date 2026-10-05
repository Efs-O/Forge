import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SEARCH_EXCLUDES,
  namedExistingPath,
  resolveSearchCodeScope,
  rgScopeArgs,
} from '../../src/tools/searchScope';
import { SNIPPETS_PER_FILE_LIMIT } from '../../src/tools/dirTools';

describe('search_code excludes', () => {
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
  // the most-edited file in this workspace: search_code reported "no matches"
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

  it('keeps relative globs rooted at the workspace', () => {
    expect(resolveSearchCodeScope('src/**/*.ts', root)).toEqual({
      target: '.',
      glob: 'src/**/*.ts',
      explicitPath: false,
      applyExcludes: true,
    });
  });

  it('allows an explicitly named absolute file outside the workspace', () => {
    const externalFile = path.join(os.tmpdir(), `forge-search-${process.pid}.txt`);
    fs.writeFileSync(externalFile, 'needle');
    try {
      expect(resolveSearchCodeScope(externalFile, root)).toEqual({
        target: externalFile,
        explicitPath: true,
        applyExcludes: false,
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
      });
    } finally {
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('does not fall back to the workspace for a missing absolute target', () => {
    expect(() =>
      resolveSearchCodeScope(path.join(os.tmpdir(), `missing-${process.pid}.py`), root),
    ).toThrow('search_code: absolute include path does not exist');
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
