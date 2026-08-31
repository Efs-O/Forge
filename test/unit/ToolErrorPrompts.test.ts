import { describe, expect, it } from 'vitest';
import { ExecCommandError } from '../../src/util/processSpawn';
import { checkPowerShellBan, checkShellOperators } from '../../src/tools/execHelpers';
import { describePathMiss } from '../../src/tools/pathErrorHint';

/**
 * These assert the *text the model receives*, which is the highest-salience
 * prompt in the system. See docs/plans/TOOL_ERROR_PROMPT_PLAN.md -- the audit
 * that motivated them found correct advice being delivered inside a
 * JSON.stringify blob for ten days.
 */

function refusalMessage(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected a refusal');
}

describe('exec error text', () => {
  // Acceptance #1
  it('never hands the model JSON', () => {
    const error = new ExecCommandError('policy_refusal', 'powershell', 'the detail sentence.');
    expect(error.message.startsWith('{')).toBe(false);
    expect(() => JSON.parse(error.message)).toThrow();
    expect(error.message).toBe('powershell: the detail sentence.');
  });

  // Acceptance #5 -- kind survives the message change; three sites read it.
  it('keeps kind and program as properties for code', () => {
    for (const kind of ['missing_executable', 'timeout', 'cancelled', 'policy_refusal'] as const) {
      const error = new ExecCommandError(kind, 'git', 'detail');
      expect(error.kind).toBe(kind);
      expect(error.program).toBe('git');
    }
  });

  // Acceptance #2 -- the guard wording was always right; check it arrives intact.
  it('names a replacement tool when PowerShell -Command is refused', () => {
    const wrapped = new ExecCommandError(
      'policy_refusal',
      'powershell',
      refusalMessage(() => checkPowerShellBan('powershell', ['-Command', 'Get-Process'])),
    );
    expect(wrapped.message).toContain('query_powershell');
    expect(wrapped.message).toContain('list_directory');
    expect(wrapped.message).not.toContain('\\"');
    expect(wrapped.message.indexOf('-Command')).toBeLessThan(40);
  });

  // Acceptance #3
  it('names the output options when a shell operator is refused', () => {
    const wrapped = new ExecCommandError(
      'invalid_shell_syntax',
      'git',
      refusalMessage(() => checkShellOperators(['log', '|', 'head'])),
    );
    expect(wrapped.message).toContain('tail_lines');
    expect(wrapped.message).toContain('There is no shell');
    expect(wrapped.message.startsWith('git: ')).toBe(true);
  });
});

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
