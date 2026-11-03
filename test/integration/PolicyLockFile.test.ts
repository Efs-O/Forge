import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockPolicyFile, policyFileIsLocked, readPolicyLockState, unlockPolicyFile } from '../../src/config/policyLock';
import { updateForgeKeyFile } from '../../src/config/ConfigWriter';
import { setNestedField } from '../../src/config/ConfigWriterHelpers';

/**
 * The real round trip, on a real file, on all three CI operating systems.
 *
 * `test/unit/PolicyLock.test.ts` pins the arguments and the report; this file is the
 * one that proves the lock does anything, because the state `policyLock.ts` reports
 * is measured by opening the file the way the next Forge write would — so a unit
 * fake could say "locked" about a command that changed nothing, and every unit
 * assertion would still pass.
 *
 * The plan's acceptance criterion is written in Windows terms (`Set-Content` from a
 * normal shell fails access denied); the equivalent here is `fs.writeFileSync`, which
 * is the same permission check `ConfigWriter`'s own atomic write will make, and it is
 * checked on every OS by the same code path.
 */

const tempDirs: string[] = [];

function cleanup(): void {
  for (const dir of tempDirs.splice(0)) {
    for (const name of fs.readdirSync(dir)) {
      const filePath = path.join(dir, name);
      try {
        // A file left locked is not deletable by this user on Windows, and not
        // writable on POSIX: unlock by mode first, which is what the POSIX branch
        // needs, and ignore the rest.
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Windows: the ACL is not a mode, so chmod cannot undo a lock here.
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function policyInTempHome(): { home: string; policyPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lock-home-'));
  tempDirs.push(home);
  fs.mkdirSync(path.join(home, '.forge'), { recursive: true });
  const policyPath = path.join(home, '.forge', 'policy.yaml');
  fs.writeFileSync(policyPath, 'permissions:\n  fs:\n    write: true\n', 'utf8');
  return { home, policyPath };
}

function writeError(filePath: string): string {
  try {
    fs.writeFileSync(filePath, 'permissions:\n  fs:\n    write: false\n', 'utf8');
    return 'wrote';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'unknown';
  }
}

afterEach(cleanup);

describe('locking the real policy file', () => {
  it('makes the file unwritable to this process, reports it, and gives the write back', () => {
    const { policyPath } = policyInTempHome();
    expect(readPolicyLockState(policyPath).state).toBe('unlocked');

    const locked = lockPolicyFile(policyPath);
    expect(locked.state).toBe('locked');
    expect(locked.writableByForge).toBe(false);
    const code = writeError(policyPath);
    expect(code === 'wrote' ? `wrote to ${policyPath}` : code).toMatch(/EACCES|EPERM/u);

    const unlocked = unlockPolicyFile(policyPath);
    expect(unlocked.state).toBe('unlocked');
    expect(unlocked.writableByForge).toBe(true);
    expect(writeError(policyPath)).toBe('wrote');
  });

  it('reports the permissions it read back, not the change it asked for', () => {
    const { policyPath } = policyInTempHome();
    const locked = lockPolicyFile(policyPath);
    // The detail is the OS's own answer: `icacls`'s lines on Windows, the mode
    // elsewhere. A report that summarised it is what would hide a permission nobody
    // intended, or a mount that ignores modes altogether.
    expect(locked.detail.length).toBeGreaterThan(0);
    expect(locked.detail).not.toContain('Successfully processed 0 files');
    if (process.platform === 'win32') {
      expect(locked.detail).toMatch(/SYSTEM|Administrators|:\(/u);
    } else {
      expect(locked.detail).toMatch(/mode \d{4}/u);
    }
    // The account the lock grants read to is the one `whoami` reported, not a name
    // pulled out of the listing.
    if (locked.grantedTo) expect(locked.grantedTo.toLowerCase()).toMatch(/[a-z0-9-]/u);
    unlockPolicyFile(policyPath);
  });

  it('leaves the file readable, because Forge still has to load it', () => {
    const { policyPath } = policyInTempHome();
    lockPolicyFile(policyPath);
    expect(fs.readFileSync(policyPath, 'utf8')).toContain('permissions');
    unlockPolicyFile(policyPath);
  });
});

describe('a locked policy file and Forge’s own writers', () => {
  it('refuses the write and names Unlock, instead of falling back to config.yaml', () => {
    const { policyPath } = policyInTempHome();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lock-config-'));
    tempDirs.push(configDir);
    const configPath = path.join(configDir, 'config.yaml');
    fs.writeFileSync(
      configPath,
      'active_model: z-cloud\nmodels:\n  - name: z-cloud\n    provider: ollama\n    endpoint: http://127.0.0.1:11434\n',
      'utf8',
    );
    lockPolicyFile(policyPath);
    try {
      // The same entry point `ChatMode.ts` uses for `engines.<name>.start_command`,
      // and the same one `llamacppIo.ts` uses for `llama_server.binary`: once the
      // file is locked, every programmatic writer of a policy key is refused, and
      // each one has to say how to undo it rather than write into config.yaml.
      updateForgeKeyFile(
        configPath,
        'permissions',
        (doc) => setNestedField(doc, ['permissions', 'fs', 'write'], false),
        { policyPath },
      );
      throw new Error('expected the locked file to refuse the write');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('locked');
      expect(message).toContain('Forge: Unlock policy.yaml');
      expect(message).toContain('does not fall back to writing config.yaml');
    }
    // config.yaml was never written to: a fallback would have put the owner's
    // permission change into the file an agent can edit.
    expect(fs.readFileSync(configPath, 'utf8')).toContain('provider: ollama');
    expect(fs.readFileSync(policyPath, 'utf8')).toContain('write: true');
    unlockPolicyFile(policyPath);
  });

  it('measures what the ACL really stops: an in-place write, not a replacement', () => {
    // The reason Forge asks about the lock itself instead of trusting the file
    // system to refuse: on Windows the parent folder's "delete child" grant lets a
    // rename replace a file this user may only read, so `writeFileAtomicSync` —
    // which works by renaming a new file over the target — would have sailed
    // straight through the lock. This pins the OS behaviour that decision rests on,
    // so nobody later "simplifies" the pre-write check by assuming the ACL covers
    // replacement as well as modification.
    const { policyPath } = policyInTempHome();
    lockPolicyFile(policyPath);
    expect(policyFileIsLocked(policyPath)).toBe(true);
    const sibling = path.join(path.dirname(policyPath), 'replacement.yaml');
    fs.writeFileSync(sibling, 'permissions:\n  fs:\n    write: false\n', 'utf8');
    expect(writeError(policyPath)).toMatch(/EACCES|EPERM/u);
    let renamed = 'renamed';
    try {
      fs.renameSync(sibling, policyPath);
    } catch (err) {
      renamed = (err as NodeJS.ErrnoException).code ?? 'failed';
    }
    const replaceable = renamed === 'renamed' ? 'rename-replaceable' : 'blocked';
    expect(replaceable).toBe(process.platform === 'win32' ? 'rename-replaceable' : 'blocked');
    if (renamed === 'renamed') {
      // The hole, stated as a fact rather than a hope: the file that arrives by\n
      // rename carries the folder's permissions, so the lock is simply gone. This is\n
      // why `updateConfigFile` and the migration check `policyFileIsLocked` first and\n
      // why the owner-only wall on `~/.forge` stays in place everywhere — the lock is\n
      // the backstop for a process that can already reach the folder, not the wall.\n
      expect(policyFileIsLocked(policyPath)).toBe(false);
    }
    unlockPolicyFile(policyPath);
  });
});
