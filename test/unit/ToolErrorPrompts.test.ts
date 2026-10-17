import { describe, expect, it } from 'vitest';
import { describePathMiss } from '../../src/tools/pathErrorHint';

/**
 * These assert the *text the model receives*, which is the highest-salience
 * prompt in the system. See docs/plans/TOOL_ERROR_PROMPT_PLAN.md -- the audit
 * that motivated them found correct advice being delivered inside a
 * JSON.stringify blob for ten days.
 */

describe('describePathMiss', () => {
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

  // Acceptance #8 -- do not invent advice for errors that already explain themselves.
  it('passes non-ENOENT errors through untouched', () => {
    const eisdir = new Error('EISDIR: illegal operation on a directory, read');
    const text = describePathMiss('read_file', 'src', eisdir);
    expect(text).toBe('read_file: EISDIR: illegal operation on a directory, read');
    expect(text).not.toContain('find_files');
  });

  it('handles a non-Error throw', () => {
    expect(describePathMiss('read_file', 'x', 'ENOENT: no such file or directory')).toContain(
      'find_files',
    );
  });
});
