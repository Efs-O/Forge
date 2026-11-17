import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLiveGitStatus } from '../../src/tools/gitRepo';
import { restoreResultText } from '../../src/tools/gitTools';

/** `restore_file` names the paths whose uncommitted changes it replaced, so an
 *  overwrite of another agent's work is visible instead of silent. */
describe('restore_file reports what it replaced', () => {
  let root = '';

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function repoWith(files: Record<string, string>): string {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-restore-note-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: root });
    git(['init', '-q']);
    git(['config', 'user.name', 'Forge Test']);
    git(['config', 'user.email', 'forge@test.invalid']);
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'fixture']);
    return root;
  }

  it('lists only the requested paths that have uncommitted changes', async () => {
    const repo = repoWith({ 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n' });
    fs.writeFileSync(path.join(repo, 'a.ts'), 'edited\n');
    fs.writeFileSync(path.join(repo, 'c.ts'), 'edited too\n');
    const entries = await readLiveGitStatus({ root: repo }, ['a.ts', 'b.ts']);
    expect(entries.map((entry) => entry.path)).toEqual(['a.ts']);
  });

  it('says nothing extra when every path was clean', () => {
    expect(restoreResultText('HEAD', ['a.ts', 'b.ts'], [])).toBe('Restored from HEAD: a.ts, b.ts');
  });

  it('names the replaced paths and how to get them back', () => {
    expect(restoreResultText('HEAD', ['a.ts', 'b.ts'], ['a.ts'])).toBe(
      'Restored from HEAD: a.ts, b.ts\nThese had uncommitted changes, now replaced: a.ts. ' +
        'If they were not yours, tell the user: Undo brings them back.',
    );
  });
});
