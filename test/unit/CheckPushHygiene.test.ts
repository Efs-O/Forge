import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { record } from '../../scripts/record-ci-pass.mjs';

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

  // A `fix(tools)` subject carries a Fix-level line, as the rule below requires.
  const good =
    'fix(tools): a saved file waits for its lock\n\nFix-level: shape\n\nCo-Authored-By: Forge <forge@evolvlabs.dev>';

  it('accepts a shaped subject with exactly one Forge trailer', () => {
    repoWith(good);
    const run = gate(['HEAD~1..HEAD']);
    expect(run.stderr).toContain('check-push');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('is clean (1 commit');
  });

  /** Runs the gate with the CI-pass check live, so the marker is what is being tested. */
  function gateRequiringCi() {
    return spawnSync(process.execPath, [script, 'HEAD~1..HEAD'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORGE_PUSH_SKIP_CI: '0' },
    });
  }

  it('accepts the marker the recorder writes for the pushed tree', () => {
    repoWith(good);
    const markerDir = path.join(root!, '.forge', 'ci-pass');
    fs.mkdirSync(markerDir, { recursive: true });
    record({ dir: markerDir, treeHash: git(['rev-parse', 'HEAD^{tree}']) });
    const run = gateRequiringCi();
    expect(run.status).toBe(0);
  });

  it('reads a marker file holding `{}` as no recorded CI pass at all', () => {
    repoWith(good);
    const markerDir = path.join(root!, '.forge', 'ci-pass');
    fs.mkdirSync(markerDir, { recursive: true });
    const tree = git(['rev-parse', 'HEAD^{tree}']);
    fs.writeFileSync(path.join(markerDir, `${tree}.json`), '{}');
    const run = gateRequiringCi();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no recorded CI pass for tree');
  });

  it.each([
    ['a subject with no type', 'Save a file when it is locked', 'type(scope): summary'],
    ['a 101-character subject', `fix(tools): ${'x'.repeat(89)}`, 'max 100'],
    ['a subject ending in a period', 'fix(tools): saves the file.', 'ends with a period'],
    ['work-in-progress anywhere', 'fix: wip the save path', 'work-in-progress'],
    ['a review-process subject', 'fix(tools): review fixes for the save path', 'names the process'],
    ['no Forge trailer', 'fix(tools): a saved file waits for its lock', 'Co-Authored-By: Forge <forge@evolvlabs.dev>` trailer, found 0'],
    ['two Forge trailers', `${good}\n${'Co-Authored-By: Forge <forge@evolvlabs.dev>'}`, 'Co-Authored-By: Forge <forge@evolvlabs.dev>` trailer, found 2'],
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

  /**
   * The Fix-level rule (CLAUDE.md § "Tool errors: fix the cause"): a
   * `fix(tools)` or `fix(prompt)` commit must name the level that removed the
   * cause. Checked at commit time by .githooks/commit-msg and again over the
   * pushed range, by the same code path in scripts/check-push.mjs.
   */
  const RULE =
    'fix(tools)/fix(prompt): the commit body must hold exactly one ' +
    '`Fix-level: shape|description|prompt|forge-bug|safety-net` line, plus ' +
    '`Cause-fix: <sha>` naming an existing commit when the level is safety-net ' +
    '(CLAUDE.md § Tool errors: fix the cause)';
  const CO = 'Co-Authored-By: Forge <forge@evolvlabs.dev>';

  /** The commit-time path: the same rule, run on the message file before the commit. */
  function commitMsgGate(message: string) {
    const file = path.join(root!, 'MSG');
    fs.writeFileSync(file, message);
    return spawnSync(process.execPath, [script, '--commit-msg', file], {
      cwd: root,
      encoding: 'utf8',
    });
  }

  const fixLevelRefusals: Array<[string, string, string]> = [
    [
      'no Fix-level line at all',
      `fix(tools): a saved file waits for its lock\n\n${CO}`,
      'found 0 Fix-level lines',
    ],
    [
      'a Fix-level value outside the list',
      `fix(tools): a saved file waits for its lock\n\nFix-level: wording\n\n${CO}`,
      'Fix-level value "wording" is not one of shape|description|prompt|forge-bug|safety-net',
    ],
    [
      'two Fix-level lines',
      `fix(tools): a saved file waits for its lock\n\nFix-level: shape\nFix-level: description\n\n${CO}`,
      'found 2 Fix-level lines',
    ],
    [
      'safety-net with no Cause-fix',
      `fix(tools): a saved file waits for its lock\n\nFix-level: safety-net\n\n${CO}`,
      'Fix-level: safety-net needs exactly one Cause-fix line (found 0)',
    ],
    [
      'a Cause-fix naming a sha that does not exist',
      `fix(tools): a saved file waits for its lock\n\nFix-level: safety-net\nCause-fix: deadbeefdeadbeef\n\n${CO}`,
      'Cause-fix deadbeefdeadbeef is not a commit that exists in this repository',
    ],
    [
      'the only Fix-level line hidden in a git comment',
      `fix(tools): a saved file waits for its lock\n\n# Fix-level: shape\n\n${CO}`,
      'found 0 Fix-level lines',
    ],
  ];

  it.each(fixLevelRefusals)('refuses a fix(tools) commit for %s', (_name, message, detail) => {
    repoWith(message);
    const atCommit = commitMsgGate(message);
    expect(atCommit.stderr).toBe(`check-push: ${RULE} — ${detail}\n`);
    expect(atCommit.status).toBe(1);
    const pushed = gate(['HEAD~1..HEAD']);
    expect(pushed.status).toBe(1);
    expect(pushed.stderr).toContain(`: ${RULE} — ${detail}`);
  });

  it.each([
    ['fix(tools) naming shape', `fix(tools): a saved file waits for its lock\n\nFix-level: shape\n\n${CO}`],
    [
      'fix(tools,sidebar) naming description',
      `fix(tools,sidebar): a saved file waits for its lock\n\nFix-level: description\n\n${CO}`,
    ],
    ['fix(prompt) naming prompt', `fix(prompt): the setup note names the voice\n\nFix-level: prompt\n\n${CO}`],
    ['fix(tools) naming forge-bug', `fix(tools): a saved file waits for its lock\n\nFix-level: forge-bug\n\n${CO}`],
    ['feat(tools) with no Fix-level line', `feat(tools): a saved file waits for its lock\n\n${CO}`],
    ['docs(tips) with no Fix-level line', `docs(tips): the table names the new gate\n\n${CO}`],
    ['fix(sidebar) with no Fix-level line', `fix(sidebar): the send button clears the draft\n\n${CO}`],
    ['fix(model-turn) with no Fix-level line', `fix(model-turn): the retry backs off\n\n${CO}`],
  ])('allows %s', (_name, message) => {
    repoWith(message);
    expect(commitMsgGate(message).status).toBe(0);
    const pushed = gate(['HEAD~1..HEAD']);
    expect(pushed.stderr).not.toContain('Fix-level');
    expect(pushed.status).toBe(0);
  });

  it('allows safety-net backed by a Cause-fix naming a real commit', () => {
    const base = 'fix(tools): a saved file waits for its lock\n\nFix-level: shape\n\n' + CO;
    repoWith(base);
    const cause = git(['rev-parse', 'HEAD~1']);
    const message = `fix(tools): a saved file waits for its lock\n\nFix-level: safety-net\nCause-fix: ${cause}\n\n${CO}`;
    expect(commitMsgGate(message).status).toBe(0);
    const pushed = gate(['HEAD~1..HEAD']);
    expect(pushed.stderr).not.toContain('Fix-level');
    expect(pushed.status).toBe(0);
  });

  it('names the rule and the CLAUDE.md section in the refusal', () => {
    repoWith('fix(prompt): the setup note names the voice\n\n' + CO);
    const run = commitMsgGate('fix(prompt): the setup note names the voice\n\n' + CO);
    expect(run.stderr).toContain('CLAUDE.md § Tool errors: fix the cause');
    expect(run.stderr).toContain('shape|description|prompt|forge-bug|safety-net');
  });

  it('installs the rule as .githooks/commit-msg', () => {
    const hook = fs.readFileSync(path.resolve('.githooks/commit-msg'), 'utf8');
    expect(hook).toContain('node scripts/check-push.mjs --commit-msg "$1"');
  });
});
