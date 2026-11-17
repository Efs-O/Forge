/**
 * The canary plant list has to stay plantable.
 *
 * `scripts/canary.mjs` (run by `npm run canary`) plants each case here in a throwaway
 * worktree and checks that the named test goes red. A case whose `find` text has been
 * reworded or moved by a refactor stops planting anything: the runner still reports the
 * case, so the only honest place to catch it is here, on every `npm test`, in the tree
 * people refactor. This is the check that turns "the gate quietly stopped guarding" into
 * a red build.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const fixturePath = path.join(root, 'test', 'fixtures', 'canary-cases.json');

interface CanaryCase {
  id: string;
  file: string;
  find: string;
  replace: string;
  test: string;
  expect: string;
}

const cases: CanaryCase[] = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as CanaryCase[];

/** Same rule the runner applies, kept here rather than imported: the runner is plain ESM
 *  with no types, and a shared helper would make `npm run canary` depend on the test tree. */
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe('the canary plant list', () => {
  it('holds a case for every gate it claims to cover', () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  it('gives every case a unique id and every field it needs', () => {
    const ids = cases.map((testCase) => testCase.id);
    expect(new Set(ids).size, 'two cases share an id, so a run cannot say which one failed').toBe(
      ids.length,
    );
    const broken = cases
      .filter(
        (testCase) =>
          [testCase.id, testCase.file, testCase.find, testCase.replace, testCase.test, testCase.expect].some(
            (value) => typeof value !== 'string' || value.trim() === '',
          ) ||
          path.isAbsolute(testCase.file) ||
          path.isAbsolute(testCase.test),
      )
      .map((testCase) => testCase.id ?? '(no id)');
    expect(broken, 'a case needs all six fields, and repo-relative paths').toEqual([]);
  });

  for (const testCase of cases) {
    it(`${testCase.id}: ${testCase.file} still holds the bug to plant, exactly once`, () => {
      const target = path.join(root, testCase.file);
      if (!fs.existsSync(target)) {
        expect(`${testCase.file} is gone`, 'move the case with the code, or drop it').toBe(
          testCase.file,
        );
      }
      const text = fs.readFileSync(target, 'utf8');
      expect(
        occurrences(text, testCase.find),
        `${testCase.file} no longer holds this text exactly once — a case that plants twice, ` +
          'or not at all, guards nothing',
      ).toBe(1);
      expect(
        occurrences(text, testCase.replace),
        `${testCase.file} already holds the buggy replacement, so this case plants nothing`,
      ).toBe(0);
      expect(fs.existsSync(path.join(root, testCase.test)), `${testCase.test} is gone`).toBe(true);
    });
  }
});
