/**
 * The two page-side readers in `browserInspect.ts` must stay byte-identical.
 *
 * Playwright serializes a page callback's BODY into the browser, so a helper
 * defined at module scope is invisible inside it — the text reader therefore
 * exists twice, once in `collectInteractiveElements` and once in `recheckNode`.
 * If they drift, an element's stored label and its rechecked label are derived
 * differently, and every index action starts refusing a node that did not
 * change (or, worse, accepting one that did). Nothing else in the type system
 * or the browser tests can see that drift, so it is pinned here against source
 * text.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SOURCE = path.resolve(__dirname, '..', '..', 'src', 'tools', 'browser', 'browserInspect.ts');

/** Extract each `const capText = (el: PageElement): string | null => {…};` body. */
function capTextBodies(source: string): string[] {
  const bodies: string[] = [];
  const marker = 'const capText = (el: PageElement): string | null => {';
  let at = source.indexOf(marker);
  while (at !== -1) {
    const start = at + marker.length;
    // Balance braces from the opening one; string/comment nesting is absent in
    // this body, so a plain counter is enough and stays honest about it.
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    if (depth !== 0) {
      throw new Error('unbalanced capText body — the extractor needs updating');
    }
    bodies.push(source.slice(start, i - 1).trim());
    at = source.indexOf(marker, i);
  }
  return bodies;
}

describe('browser_inspect page readers', () => {
  it('defines the text reader exactly twice — once per page callback', () => {
    const bodies = capTextBodies(fs.readFileSync(SOURCE, 'utf8'));
    expect(bodies.length).toBe(2);
  });

  it('keeps both readers byte-identical', () => {
    const [collect, recheck] = capTextBodies(fs.readFileSync(SOURCE, 'utf8'));
    expect(recheck).toBe(collect);
  });

  it('keeps the in-page scan cap matching the exported limit it mirrors', async () => {
    // The callback cannot import, so the number is inlined; if the exported
    // limit moves and the inlined copy does not, inspect and recheck disagree.
    const mod = await import('../../src/tools/browser/browserInspect');
    const bodies = capTextBodies(fs.readFileSync(SOURCE, 'utf8'));
    for (const body of bodies) {
      expect(body).toContain(`raw.length > ${mod.TEXT_SCAN_LIMIT}`);
      expect(body).toContain(`raw.slice(0, ${mod.TEXT_SCAN_LIMIT})`);
    }
  });
});
