import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SEARCH_EXCLUDES,
  namedExistingPath,
  resolveSearchCodeScope,
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
    });
  });

  it('allows an explicitly named absolute file outside the workspace', () => {
    const externalFile = path.join(os.tmpdir(), `forge-search-${process.pid}.txt`);
    fs.writeFileSync(externalFile, 'needle');
    try {
      expect(resolveSearchCodeScope(externalFile, root)).toEqual({
        target: externalFile,
        explicitPath: true,
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
});
