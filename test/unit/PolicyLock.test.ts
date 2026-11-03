import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  lockPolicyFile,
  policyLockSentence,
  readPolicyLockState,
  unlockPolicyFile,
  type LockCommandRunner,
} from '../../src/config/policyLock';

/**
 * The commands behind `Forge: Lock policy.yaml` and `Forge: Unlock policy.yaml`.
 *
 * Two kinds of test, deliberately: this file pins the ARGUMENTS Forge sends and the
 * REPORT it gives back, using a fake that returns the text the real `icacls`
 * produced on this machine; `test/integration/PolicyLockFile.test.ts` does the real
 * round trip and proves a write really fails while the file is locked. A fake alone
 * would not be enough here, because the state this file reports is measured by
 * opening the file, not by reading `icacls`'s answer — so a fake that only ever
 * said "locked" could hide a command that does nothing.
 *
 * The fake returns real output rather than a tidy object for the same reason the
 * repo has been bitten by before: a fake that returned what the code expects, instead
 * of what the program returns, hides the bug that only the real bytes expose.
 */

const tempDirs: string[] = [];

function mkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lock-'));
  tempDirs.push(dir);
  return dir;
}

function mkFile(contents = '# the owner’s policy\npermissions:\n  fs:\n    write: true\n'): string {
  const filePath = path.join(mkDir(), 'policy.yaml');
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.chmodSync(path.join(dir, name), 0o600);
      } catch {
        // A Windows ACL is not a mode; chmod here is only to make the cleanup below
        // able to remove a file the POSIX branch left read-only.
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** `whoami.exe /user /fo csv /nh`, exactly as this machine answered it. */
const WHOAMI = '"example-pc\\example-pc","S-1-5-21-1111111111-2222222222-3333333333-1001"\n';
/** `icacls <file>` after the lock command, as this machine printed it. The DENY line
 *  is real output, not a decoration: it is the entry that makes the lock hold
 *  against a rename, and a fake that left it out would let a lock command without
 *  the deny ACE look exactly like one with it.
 */
const LOCKED_LISTING =
  'policy.yaml EXAMPLE-PC\\EXAMPLE-PC:(DENY)(D)\n' +
  '                         NT AUTHORITY\\SYSTEM:(F)\n' +
  '                         BUILTIN\\Administrators:(F)\n' +
  '                         EXAMPLE-PC\\EXAMPLE-PC:(R)\n' +
  '\nSuccessfully processed 1 files; Failed processing 0 files\n';

/** A runner that records what was asked and answers as the real tool would. */
function fakeRunner(
  answers: Record<string, { status: number; stdout: string; stderr: string }>,
): { run: LockCommandRunner; asked: Array<{ program: string; args: string[] }> } {
  const asked: Array<{ program: string; args: string[] }> = [];
  return {
    asked,
    run: (program, args) => {
      asked.push({ program, args });
      const key = program.endsWith('whoami.exe') ? 'whoami' : 'icacls';
      return answers[key] ?? { status: 0, stdout: '', stderr: '' };
    },
  };
}

describe('reading the policy file’s state', () => {
  it('calls a missing file absent, and says what to do about it', () => {
    const report = readPolicyLockState(path.join(mkDir(), 'nope.yaml'));
    expect(report.state).toBe('absent');
    expect(report.writableByForge).toBe(false);
    expect(policyLockSentence(report)).toContain('Move security settings to policy.yaml');
  });

  it('reports an ordinary file as unlocked', () => {
    const report = readPolicyLockState(mkFile());
    expect(report.state).toBe('unlocked');
    expect(report.writableByForge).toBe(true);
    expect(policyLockSentence(report)).toContain('Lock policy.yaml');
  });

  it('refuses to lock or unlock a file that is not there, naming the migration', () => {
    const missing = path.join(mkDir(), 'policy.yaml');
    for (const [label, action] of [
      ['lock', () => lockPolicyFile(missing)],
      ['unlock', () => unlockPolicyFile(missing)],
    ]) {
      try {
        action();
        throw new Error(`expected ${label} to throw`);
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('does not exist');
        expect(message).toContain('Move security settings to policy.yaml');
      }
    }
  });
});

describe('the Windows lock command', () => {
  const answers = {
    whoami: { status: 0, stdout: WHOAMI, stderr: '' },
    icacls: { status: 0, stdout: LOCKED_LISTING, stderr: '' },
  };

  it.runIf(process.platform === 'win32')(
    'grants read to the current user as a SID, and write to Administrators and SYSTEM',
    () => {
      const filePath = mkFile();
      const fake = fakeRunner(answers);
      // The fake does not change the file's real permissions, so the lock's own
      // re-read finds the file still writable — which is the failure this file
      // tests below. Here the command is what matters, so the re-read is bypassed
      // by asking the runner and checking what it was handed.
      try {
        lockPolicyFile(filePath, { run: fake.run });
        throw new Error('expected the re-read to disagree with the fake');
      } catch (err) {
        expect((err as Error).message).toContain('disagrees');
      }
      const call = fake.asked.find((row) => row.program.endsWith('icacls.exe'));
      expect(call?.args).toContain('/inheritance:r');
      expect(call?.args).toContain('*S-1-5-21-1111111111-2222222222-3333333333-1001:R');
      expect(call?.args).toContain('*S-1-5-32-544:F');
      expect(call?.args).toContain('*S-1-5-18:F');
      // The deny ACE is what stops a rename. An owner has DELETE on their own file
      // implicitly, so `Set-Content` failing while `mv` succeeds is the difference
      // between a lock and a suggestion — and Forge's own writer renames.
      expect(call?.args).toContain('/deny');
      expect(call?.args).toContain('*S-1-5-21-1111111111-2222222222-3333333333-1001:(DE)');
      expect(call?.args).toContain(filePath);
      // `C:/Windows/System32`, not a bare `icacls`: an MSYS `whoami` earlier on PATH
      // rejects these arguments, and a lock granted to the wrong account reads as
      // success while locking out the owner's own reads.
      expect(call?.program).toMatch(/System32[\\/]icacls\.exe$/u);
      expect(fake.asked.some((row) => row.args.includes('/user'))).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')('passes unlock to `icacls /reset`', () => {
    const filePath = mkFile();
    const fake = fakeRunner({
      whoami: answers.whoami,
      icacls: { status: 0, stdout: LOCKED_LISTING, stderr: '' },
    });
    // The file is really writable, so an unlock that reports "unlocked" succeeds
    // without needing the fake to have done anything.
    const report = unlockPolicyFile(filePath, { run: fake.run });
    expect(report.state).toBe('unlocked');
    const call = fake.asked.find((row) => row.program.endsWith('icacls.exe'));
    expect(call?.args).toEqual([filePath, '/reset']);
  });

  it.runIf(process.platform === 'win32')(
    'says what icacls said, when it refuses',
    () => {
      const filePath = mkFile();
      const fake = fakeRunner({
        whoami: answers.whoami,
        icacls: { status: 9, stdout: '', stderr: 'Access is denied.\n' },
      });
      try {
        lockPolicyFile(filePath, { run: fake.run });
        throw new Error('expected lockPolicyFile to throw');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('refused to lock');
        expect(message).toContain('Access is denied.');
        expect(message).toContain(filePath);
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'refuses to guess an account when it cannot ask who this is',
    () => {
      const filePath = mkFile();
      const fake = fakeRunner({
        whoami: { status: 0, stdout: 'runner\n', stderr: '' },
        icacls: answers.icacls,
      });
      try {
        lockPolicyFile(filePath, { run: fake.run });
        throw new Error('expected lockPolicyFile to throw');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('could not ask who this user is');
        expect(message).toContain('will not guess');
      }
      expect(fake.asked.some((row) => row.program.endsWith('icacls.exe'))).toBe(false);
    },
  );
});

describe('the POSIX lock, where there is no icacls', () => {
  it.runIf(process.platform !== 'win32')('takes the write bits off, and gives them back', () => {
    const filePath = mkFile();
    const locked = lockPolicyFile(filePath);
    expect(locked.state).toBe('locked');
    expect(fs.statSync(filePath).mode & 0o222).toBe(0);
    expect(locked.detail).toMatch(/mode /u);
    const unlocked = unlockPolicyFile(filePath);
    expect(unlocked.state).toBe('unlocked');
    expect(fs.statSync(filePath).mode & 0o200).not.toBe(0);
  });
});

describe('the sentence the owner reads', () => {
  it('names the way back for a locked file, and says Forge will not fall back', () => {
    const sentence = policyLockSentence({
      policyPath: 'C:/Users/someone/.forge/policy.yaml',
      state: 'locked',
      writableByForge: false,
      detail: 'policy.yaml NT AUTHORITY\\SYSTEM:(F)\n  BUILTIN\\Administrators:(F)\n  someone:(R)',
      grantedTo: 'example-pc\\example-pc',
    });
    expect(sentence).toContain('LOCKED');
    expect(sentence).toContain('example-pc\\example-pc');
    expect(sentence).toContain('Unlock policy.yaml');
    expect(sentence).toContain('does not fall back to config.yaml');
  });

  it('says what an unlocked file means for the agent, not just for Forge', () => {
    const sentence = policyLockSentence({
      policyPath: 'C:/Users/someone/.forge/policy.yaml',
      state: 'unlocked',
      writableByForge: true,
      detail: 'mode 644',
    });
    expect(sentence).toContain('anything this user runs can');
    expect(sentence).toContain('Lock policy.yaml');
  });
});
