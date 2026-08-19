import { describe, expect, it } from 'vitest';
import { SEARCH_EXCLUDES, SNIPPETS_PER_FILE_LIMIT } from '../../src/tools/dirTools';

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
    expect(SEARCH_EXCLUDES).toContain('!**/.forge/**');
  });

  // A per-file cap is what stops any single noisy file from starving the rest,
  // whether or not it is one we thought to exclude.
  it('caps snippets per file so one file cannot consume the whole result', () => {
    expect(SNIPPETS_PER_FILE_LIMIT).toBeGreaterThan(0);
    expect(SNIPPETS_PER_FILE_LIMIT).toBeLessThan(50);
  });
});
