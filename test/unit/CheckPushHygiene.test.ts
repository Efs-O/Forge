import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The push gate (scripts/check-push.mjs): what it refuses, and the fact that
 * under --pre-push it checks the commits being pushed rather than HEAD's
 * upstream. Nothing is grandfathered, so every case here is a real verdict.
 */
describe('push hygiene gate', () => {
  const script = path.resolve('scripts/check-push.mjs');
  let root: string | undefined;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function git(args: string[], opts: { input?: string } = {}) {
    const run = spawnSync('git', args, {
      cwd: root!,
      encoding: 'utf8',
      input: opts.input,
    });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
    return run.stdout.trim();
  }

  /** One base commit, then the commit under test, so the range is one commit. */
  function repoWith(message: string) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-push-gate-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Forge Test']);
    git(['config', 'user.email', 'forge@test.invalid']);
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'chore: base\n\nCo-Authored-By: Forge <forge@evolvlabs.dev>']);
    fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-F', '-'], { input: message });
    return root;
  }

  function gate(args: string[], input?: string) {
    return spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: 'utf8',
      input,
      env: { ...process.env, FORGE_PUSH_SKIP_CI: '1' },
    });
  }

  const good = 'fix(tools): a saved file waits for its lock\n\nCo-Authored-By: Forge <forge@evolvlabs.dev>';

  it('accepts a shaped subject with exactly one Forge trailer', () => {
    repoWith(good);
    const run = gate(['HEAD~1..HEAD']);
    expect(run.stderr).toContain('check-push');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('is clean (1 commit');
  });

  it.each([
    ['a subject with no type', 'Save a file when it is locked', 'type(scope): summary'],
    ['a 101-character subject', `fix(tools): ${'x'.repeat(89)}`, 'max 100'],
    ['a subject ending in a period', 'fix(tools): saves the file.', 'ends with a period'],
    ['work-in-progress anywhere', 'fix: wip the save path', 'work-in-progress'],
    ['a review-process subject', 'fix(tools): review fixes for the save path', 'names the process'],
    ['no Forge trailer', 'fix(tools): a saved file waits for its lock', 'found 0'],
    ['two Forge trailers', `${good}\n${'Co-Authored-By: Forge <forge@evolvlabs.dev>'}`, 'found 2'],
    ['the trailer not last', 'fix(tools): a saved file\n\nCo-Authored-By: Forge <forge@evolvlabs.dev>\n\nNote after it.', 'last line'],
  ])('refuses %s', (_name, message, needle) => {
    repoWith(message);
    const run = gate(['HEAD~1..HEAD']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(needle);
  });

  it('refuses a merge commit in the range', () => {
    repoWith(good);
    git(['checkout', '-q', '-b', 'side', 'HEAD~1']);
    fs.writeFileSync(path.join(root!, 'b.txt'), 'side\n');
    git(['add', 'b.txt']);
    git(['commit', '-q', '-m', 'feat(side): a side file\n\nCo-Authored-By: Forge <forge@evolvlabs.dev>']);
    git(['checkout', '-q', 'main']);
    git(['merge', '--no-ff', '-q', '-m', 'Merge branch side', 'side']);
    const run = gate(['HEAD~2..HEAD']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('merge commit(s)');
  });

  it('under --pre-push checks the commits being pushed, not HEAD upstream', () => {
    repoWith(good);
    const mainSha = git(['rev-parse', 'HEAD']);
    // A branch whose tip is sloppy is what the owner is actually pushing.
    git(['checkout', '-q', '-b', 'other']);
    fs.writeFileSync(path.join(root!, 'c.txt'), 'three\n');
    git(['add', 'c.txt']);
    git(['commit', '-q', '-m', 'wip: not finished\n\nCo-Authored-By: Forge <forge@evolvlabs.dev>']);
    const otherSha = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']);
    const run = gate(['--pre-push'], `refs/heads/other ${otherSha} refs/heads/main ${mainSha}\n`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('wip: not finished');
  });
});
