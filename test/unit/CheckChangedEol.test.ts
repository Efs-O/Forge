import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('check:changed CRLF repair', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('only reports diff-listed files, and fixes a named file with eol=lf', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-check-changed-eol-'));
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'forge@test.invalid'], { cwd: root });
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.md text eol=lf\n');
    fs.writeFileSync(path.join(root, 'notes.md'), 'old\n');
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { 'type-check': 'node -e "process.exit(0)"' } }),
    );
    execFileSync('git', ['add', '.gitattributes', 'notes.md', 'package.json'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });

    fs.writeFileSync(path.join(root, 'notes.md'), Buffer.from('changed\r\nline\r\n'));
    const script = path.resolve('scripts/check-changed.mjs');
    const report = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(report.status).toBe(0);
    expect(report.stdout).toContain('run `npm run check:changed -- notes.md` to fix it');
    expect(fs.readFileSync(path.join(root, 'notes.md'))).toEqual(
      Buffer.from('changed\r\nline\r\n'),
    );

    const fixed = spawnSync(process.execPath, [script, 'notes.md'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(fixed.status).toBe(0);
    expect(fixed.stdout).toContain('check:changed: fixed CRLF line endings in notes.md');
    expect(fs.readFileSync(path.join(root, 'notes.md'))).toEqual(Buffer.from('changed\nline\n'));
  }, 15_000);
});
