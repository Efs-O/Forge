import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeExecCommand,
  describeShellBuiltin,
  describeWrongPlatformProgram,
  matchPackageRunner,
  resolveExecInvocation,
  resolvePackageRunnerInvocation,
  type RunnerProbe,
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

// Built with the host's own separator: resolvePackageRunnerInvocation uses
// node's `path`, which follows the machine the test runs on, not the `platform`
// argument. Spelling the separator by hand would only pass on Windows.
const NODE_DIR = path.join('C:', 'Program Files', 'nodejs');
const PREFIX_DIR = path.join('C:', 'Users', 'dev', 'AppData', 'Roaming', 'npm');

function probeFor(present: string[], pathHits: Record<string, string[]>): RunnerProbe {
  return {
    which: (program) => pathHits[program.toLowerCase()] ?? [],
    exists: (candidate) => present.includes(candidate),
  };
}

describe('resolvePackageRunnerInvocation on Windows', () => {
  const nodeShim = path.join(NODE_DIR, 'npm.cmd');
  const prefixShim = path.join(PREFIX_DIR, 'npm.cmd');
  const nodeExe = path.join(NODE_DIR, 'node.exe');
  const nodeCli = path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const prefixCli = path.join(PREFIX_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');

  it('uses a shim that has node.exe beside it', () => {
    const probe = probeFor([nodeExe, nodeCli], { 'npm.cmd': [nodeShim] });
    expect(resolvePackageRunnerInvocation('npm', 'win32', probe)).toEqual({
      command: nodeExe,
      argsPrefix: [nodeCli],
    });
  });

  // `npm install -g npm` puts a shim in the npm prefix directory, which has no
  // node.exe beside it and usually comes FIRST on PATH. Taking the first shim
  // and demanding an adjacent node.exe is what broke every `npm run <script>`.
  it('skips a prefix shim with no adjacent node.exe for the self-contained one', () => {
    const probe = probeFor([nodeExe, nodeCli, prefixCli], {
      'npm.cmd': [prefixShim, nodeShim],
    });
    expect(resolvePackageRunnerInvocation('npm', 'win32', probe)).toEqual({
      command: nodeExe,
      argsPrefix: [nodeCli],
    });
  });

  it('falls back to node from PATH when no shim is self-contained', () => {
    const probe = probeFor([prefixCli], {
      'npm.cmd': [prefixShim],
      'node.exe': [nodeExe],
    });
    expect(resolvePackageRunnerInvocation('npm', 'win32', probe)).toEqual({
      command: nodeExe,
      argsPrefix: [prefixCli],
    });
  });

  it('names the CLI it found when node is nowhere on PATH', () => {
    const probe = probeFor([prefixCli], { 'npm.cmd': [prefixShim] });
    expect(() => resolvePackageRunnerInvocation('npm', 'win32', probe)).toThrow(
      /no node\.exe on PATH/u,
    );
  });

  it('names every root it looked in when no CLI exists at all', () => {
    const probe = probeFor([], { 'npm.cmd': [prefixShim, nodeShim] });
    expect(() => resolvePackageRunnerInvocation('npm', 'win32', probe)).toThrow(/looked in/u);
  });

  it('still reports a shim that is not on PATH at all', () => {
    const probe = probeFor([], {});
    expect(() => resolvePackageRunnerInvocation('npm', 'win32', probe)).toThrow(
      /shim was not found/u,
    );
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

  // The reported failure: exec_command grep returned a bare `spawn grep ENOENT`
  // naming nothing usable, and the agent went looking for a workaround instead
  // of calling search_code, which had ripgrep behind it the whole time.
  it('points every spelling of grep at search_code', () => {
    for (const spelling of ['grep', 'egrep', 'fgrep', 'rg', 'ripgrep', 'ack']) {
      expect(describeShellBuiltin(spelling)).toContain('search_code');
    }
  });

  it('names read_file for the Unix pagers', () => {
    for (const spelling of ['cat', 'head', 'tail', 'less']) {
      expect(describeShellBuiltin(spelling)).toContain('read_file');
    }
  });

  // A Windows model reaches for the .exe spelling as soon as the bare name
  // fails, so both have to land on the same advice.
  it('strips an executable extension before matching', () => {
    expect(describeShellBuiltin('grep.exe')).toContain('search_code');
    expect(describeShellBuiltin(String.raw`C:\Program Files\Git\usr\bin\grep.exe`)).toContain(
      'search_code',
    );
  });

  // find and findstr are real programs on Windows: they spawn fine, so this map
  // never sees them, and claiming them here would refuse work that succeeds.
  // Unix-shaped `find` is handled by argv instead — see below.
  it('leaves the programs that actually exist alone', () => {
    expect(describeShellBuiltin('findstr')).toBeUndefined();
    expect(describeShellBuiltin('find')).toBeUndefined();
  });
});

describe('describeWrongPlatformProgram', () => {
  it('catches Unix find on Windows before it reaches find.exe', () => {
    expect(describeWrongPlatformProgram('find', ['.', '-name', '*.ts'], 'win32')).toContain(
      'find_files',
    );
    expect(
      describeWrongPlatformProgram('find', ['src', '-type', 'f', '-maxdepth', '2'], 'win32'),
    ).toContain('find_files');
  });

  // The whole point of matching on argv: this command works, and refusing it
  // would teach the agent a capability it has does not exist.
  it('lets a genuine Windows find through', () => {
    expect(
      describeWrongPlatformProgram('find', ['/c', 'needle', 'file.txt'], 'win32'),
    ).toBeUndefined();
    expect(
      describeWrongPlatformProgram('find', ['/v', '/n', 'x', 'a.txt'], 'win32'),
    ).toBeUndefined();
  });

  // On Linux and macOS `find` IS the Unix one, so intercepting would break a
  // command that does exactly what was asked.
  it('never fires off Windows', () => {
    expect(describeWrongPlatformProgram('find', ['.', '-name', '*.ts'], 'linux')).toBeUndefined();
    expect(describeWrongPlatformProgram('find', ['.', '-name', '*.ts'], 'darwin')).toBeUndefined();
  });

  it('matches predicates as whole tokens, never as substrings', () => {
    // A filename that merely contains a predicate must not trip the check.
    expect(
      describeWrongPlatformProgram('find', ['/c', '-nameplate', 'a.txt'], 'win32'),
    ).toBeUndefined();
  });

  it('says nothing about other programs', () => {
    expect(describeWrongPlatformProgram('git', ['-name', 'x'], 'win32')).toBeUndefined();
    expect(describeWrongPlatformProgram('findstr', ['-name', 'x'], 'win32')).toBeUndefined();
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
