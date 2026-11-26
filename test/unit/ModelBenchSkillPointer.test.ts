/**
 * The bench rule in this workspace's `FORGE.md` must point at the `model-bench`
 * skill instead of restating the stop/bench/restore procedure in prose.
 *
 * Why this is a test and not a comment: every bench that needs the GPUs used to
 * re-implement "take the chat model down, run the bench, put it back", each time
 * slightly differently. On 2026-11-06 two Strata engines ended up on GPUs 0+1 at
 * once because the chat that launched a bench also started a `notify_on_exit`
 * watcher, its timeout fired mid-bench, and the turn that notice started loaded
 * the chat model back on top of the bench engine. The prose that described the
 * procedure could not stop that; one skill that owns it can, but only while the
 * instruction file still sends an agent to it.
 *
 * `FORGE.md` is gitignored, so a CI runner has no copy of it: the first half is
 * for the machine that owns the file, and the second half only runs when the
 * skill folder is installed there. A clean checkout therefore checks nothing but
 * its own shape, which is what the plan asked for (docs/plans/MODEL_BENCH_RUNNERS_PLAN.md,
 * "CI-enforceable row").
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.resolve(__dirname, '..', '..');
const forgeMdPath = path.join(root, 'FORGE.md');

/** The skill's home, spelled the way `FORGE.md` must spell it. */
const SKILL_PATH_TEXT = '~/.forge/skills/model-bench/';
/** The account's own profile, not the throwaway home `tempGuard.setup.ts` gives
 *  a test file: what this checks is the skill the operator installed there, so
 *  it has to look where that install lives. `userInfo()` reads the account (the
 *  token's profile folder on Windows, the passwd entry elsewhere) and ignores
 *  the `USERPROFILE` / `HOME` the guard redirects. */
const REAL_PROFILE = os.userInfo().homedir;
const skillFolder = path.join(REAL_PROFILE, '.forge', 'skills', 'model-bench');

/** The words the old prose rule used, which must not come back alongside the pointer. */
const RETIRED_PROCSE = [
  /stop\/restart each server with its own stop script/u,
  /wait for the last engine to exit and RAM to return/u,
];

function readForgeMd(): string | undefined {
  if (!fs.existsSync(forgeMdPath)) return undefined;
  return fs.readFileSync(forgeMdPath, 'utf8');
}

/** The bullet that carries the bench rule, as one string. */
function benchRule(forge: string): string {
  const bullets = forge
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') && line.includes(SKILL_PATH_TEXT));
  expect(bullets).toHaveLength(1);
  return bullets[0]!;
}

describe('FORGE.md bench rule', () => {
  const forge = readForgeMd();

  it('points at the model-bench skill, and only there', () => {
    if (forge === undefined) return; // gitignored: no copy on a CI runner
    const rule = benchRule(forge);
    expect(rule).toContain(SKILL_PATH_TEXT);
    expect(rule).toContain('SKILL.md');
    // Rule 1: detached launch, end the turn. Rule 2: no watcher following a bench.
    expect(rule).toMatch(/detached/u);
    expect(rule).toMatch(/end the turn/u);
    expect(rule).toMatch(/notify_on_exit/u);
    // The procedure it replaced stays out, so there is one copy of it to keep true.
    for (const retired of RETIRED_PROCSE) expect(forge).not.toMatch(retired);
  });

  it('keeps the rule short enough to be read, not skimmed', () => {
    if (forge === undefined) return;
    // One bullet, and no more than the four lines the plan allowed for it.
    expect(benchRule(forge).split('\n')).toHaveLength(1);
    expect(benchRule(forge).length).toBeLessThan(900);
  });
});

describe('the model-bench skill, when this machine has it installed', () => {
  const installed = fs.existsSync(skillFolder);

  it.skipIf(!installed)('SKILL.md and scripts/lib.sh are where FORGE.md says they are', () => {
    expect(fs.statSync(path.join(skillFolder, 'SKILL.md')).isFile()).toBe(true);
    expect(fs.statSync(path.join(skillFolder, 'scripts', 'lib.sh')).isFile()).toBe(true);
  });

  it.skipIf(!installed)('the registry the library reads is there too', () => {
    expect(fs.statSync(path.join(skillFolder, 'scripts', 'models.sh')).isFile()).toBe(true);
  });
});
