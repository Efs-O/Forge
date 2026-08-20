import { describe, expect, it } from 'vitest';
import {
  canonicalizeExecCommand,
  describeShellBuiltin,
  matchPackageRunner,
  resolveExecInvocation,
} from '../../src/tools/execProgramResolver';
import { checkDenyList, getBuiltinDenyList } from '../../src/tools/DenyList';

describe('matchPackageRunner', () => {
  it('recognises the bare names', () => {
    expect(matchPackageRunner('npm')).toBe('npm');
    expect(matchPackageRunner('npx')).toBe('npx');
  });

  it('recognises the .cmd form the model reaches for after ENOENT', () => {
    expect(matchPackageRunner('npm.cmd')).toBe('npm');
    expect(matchPackageRunner('NPX.CMD')).toBe('npx');
  });

  // An absolute path is left alone on purpose: canonicalising it would mean
  // re-resolving through PATH and possibly running a different npm.
  it('does NOT recognise an absolute path to the shim', () => {
    expect(matchPackageRunner('C:\\Program Files\\nodejs\\npm.cmd')).toBeUndefined();
  });

  it('leaves everything else alone', () => {
    expect(matchPackageRunner('node')).toBeUndefined();
    expect(matchPackageRunner('npmx')).toBeUndefined();
    expect(matchPackageRunner('git')).toBeUndefined();
  });
});

describe('resolveExecInvocation', () => {
  it('passes non-runner commands through untouched', () => {
    expect(resolveExecInvocation('node', ['x.mjs'], 'win32')).toEqual({
      command: 'node',
      args: ['x.mjs'],
    });
  });

  it('leaves npm alone off Windows, where the shim problem does not exist', () => {
    expect(resolveExecInvocation('npm', ['install'], 'linux')).toEqual({
      command: 'npm',
      args: ['install'],
    });
  });
});

describe('describeShellBuiltin', () => {
  it('names list_directory for dir', () => {
    expect(describeShellBuiltin('dir')).toContain('list_directory');
  });

  it('names delete_file for del', () => {
    expect(describeShellBuiltin('del')).toContain('delete_file');
  });

  it('is case-insensitive', () => {
    expect(describeShellBuiltin('DIR')).toContain('list_directory');
  });

  it('says nothing about real programs', () => {
    expect(describeShellBuiltin('node')).toBeUndefined();
    expect(describeShellBuiltin('git')).toBeUndefined();
  });
});

describe('canonicalizeExecCommand keeps the denylist effective', () => {
  it('collapses npm.cmd to npm', () => {
    expect(canonicalizeExecCommand('npm.cmd')).toBe('npm');
    expect(canonicalizeExecCommand('NPM.CMD')).toBe('npm');
  });

  it('leaves anything else exactly as written', () => {
    expect(canonicalizeExecCommand('git')).toBe('git');
    expect(canonicalizeExecCommand('C:\\tools\\thing.cmd')).toBe('C:\\tools\\thing.cmd');
  });

  // Before resolution existed, npm.cmd could not spawn at all, so the denylist
  // never had to know the spelling. Now that it runs, it must.
  it('closes the npm.cmd route around the recursive-delete guard', () => {
    const deny = getBuiltinDenyList();
    expect(checkDenyList('npm', ['rm', '-rf', '.'], deny)).not.toBeNull();
    expect(
      checkDenyList(canonicalizeExecCommand('npm.cmd'), ['rm', '-rf', '.'], deny),
    ).not.toBeNull();
  });
});
