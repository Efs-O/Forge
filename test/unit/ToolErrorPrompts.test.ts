import { afterEach, describe, expect, it } from 'vitest';
import { describePathMiss } from '../../src/tools/pathErrorHint';
import { formatPathMiss } from '../../src/tools/pathMissText';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workspace } from '../support/vscode';
import * as vscode from '../support/vscode';
import { resolveRipgrep } from '../../src/tools/RipgrepResolver';
import { resolveLiveAppRoot } from '../live/liveModelHarness';

/**
 * These assert the *text the model receives*, which is the highest-salience
 * prompt in the system. See docs/plans/TOOL_ERROR_PROMPT_PLAN.md -- the audit
 * that motivated them found correct advice being delivered inside a
 * JSON.stringify blob for ten days.
 */

describe('describePathMiss', () => {
  const bundledRg = resolveRipgrep(resolveLiveAppRoot());
  const realRg = fs.existsSync(bundledRg.command) ? bundledRg : undefined;
  const previousAppRoot = vscode.env.appRoot;

  afterEach(() => {
    vscode.env.appRoot = previousAppRoot;
  });
  const enoent = new Error("ENOENT: no such file or directory, open 'n:\\ws\\a\\b.ts'");

  // Acceptance #6 and #7 -- both tools share this helper.
  it('names the requested path, the base it resolved against, and find_files', () => {
    const text = describePathMiss('read_file', 'a/b.ts', enoent);
    expect(text.startsWith('read_file: nothing exists there.')).toBe(true);
    expect(text).toContain('"a/b.ts"');
    expect(text).toContain('find_files');
    // The trap this exists for: a right-looking path under the wrong base.
    expect(text).toContain('workspace root is often not the project root');
  });

  it('suggests the unique same-name file reported by ripgrep', () => {
    const miss = new Error(
      "ENOENT: no such file or directory, open 'scripts/session-scan/logscan.py'",
    );
    expect(
      formatPathMiss(
        'read_file',
        'scripts/session-scan/logscan.py',
        miss,
        'N:/vs code apps/Forge',
        'scripts/lab-sync/logscan.py',
      ),
    ).toBe(
      'read_file: nothing exists there. "scripts/session-scan/logscan.py" resolved against the workspace root N:/vs code apps/Forge. ' +
        "ENOENT: no such file or directory, open 'scripts/session-scan/logscan.py' " +
        'Did you mean "scripts/lab-sync/logscan.py"? ' +
        'The workspace root is often not the project root, so a path that looks right for the project can still miss. Use find_files to locate it before retrying.',
    );
  });

  it.skipIf(realRg === undefined)('gets a same-name suggestion from a real ripgrep workspace crawl', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-readfile-suggestion-'));
    const previous = workspace.workspaceFolders;
    vscode.env.appRoot = resolveLiveAppRoot();
    fs.mkdirSync(path.join(root, 'scripts', 'lab-sync'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'lab-sync', 'logscan.py'), 'pass\n');
    workspace.workspaceFolders = [{ uri: { fsPath: root } }];
    try {
      const result = describePathMiss(
        'read_file',
        'scripts/session-scan/logscan.py',
        Object.assign(
          new Error("ENOENT: no such file or directory, open 'scripts/session-scan/logscan.py'"),
          { code: 'ENOENT' },
        ),
      );
      expect(result).toBe(
        `read_file: nothing exists there. "scripts/session-scan/logscan.py" resolved against the workspace root ${root}. ` +
          "ENOENT: no such file or directory, open 'scripts/session-scan/logscan.py' " +
          'Did you mean "scripts/lab-sync/logscan.py"? ' +
          'The workspace root is often not the project root, so a path that looks right for the project can still miss. Use find_files to locate it before retrying.',
      );
    } finally {
      workspace.workspaceFolders = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // An absolute path never touched the workspace root, so naming it misled (U16-08).
  it('says an absolute path was used as given, without the workspace-root advice', () => {
    const absolute = process.platform === 'win32' ? 'C:\\proj\\b.ts' : '/proj/b.ts';
    const text = describePathMiss('read_file', absolute, enoent);
    expect(text).toContain('is absolute, so it was used as given');
    expect(text).toContain('find_files');
    expect(text).not.toContain('workspace root');
  });

  it('carries the tool name it was given', () => {
    expect(describePathMiss('list_directory', 'src', enoent)).toContain('list_directory:');
  });

  // VS Code's own file API words a miss differently, and `read_notebook` goes through it
  // (lab arm U5a): the same miss must produce the same answer, not a raw internal string.
  it('treats VS Code\'s "nonexistent file" wording as the same miss', () => {
    const vscodeMiss = new Error(
      "Unable to read file 'n:\\ws\\a\\b.ipynb' (Error: Unable to resolve nonexistent file 'n:\\ws\\a\\b.ipynb')",
    );
    const text = describePathMiss('read_notebook', 'a/b.ipynb', vscodeMiss);
    expect(text.startsWith('read_notebook: nothing exists there.')).toBe(true);
    expect(text).toContain('find_files');
  });

  it('names directory-reading alternatives for read_file EISDIR errors', () => {
    const eisdir = new Error('EISDIR: illegal operation on a directory, read');
    const text = describePathMiss('read_file', 'docs/plans', eisdir);
    expect(text).toContain('"docs/plans" is a directory');
    expect(text).toContain('list_directory');
    expect(text).toContain('find_files');
  });

  it('passes EISDIR through untouched for non-read callers', () => {
    const eisdir = new Error('EISDIR: illegal operation on a directory, read');
    expect(describePathMiss('list_directory', 'src', eisdir)).toBe(
      'list_directory: EISDIR: illegal operation on a directory, read',
    );
  });

  it('handles a non-Error throw', () => {
    expect(describePathMiss('read_file', 'x', 'ENOENT: no such file or directory')).toContain(
      'find_files',
    );
  });
});
