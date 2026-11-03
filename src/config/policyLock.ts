import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * `Forge: Lock policy.yaml` and `Forge: Unlock policy.yaml` — the owner's switch on
 * the file that says what an agent may do.
 *
 * From phase 3 an agent can edit `config.yaml`, and `ConfigLoader` refuses the policy
 * keys and the program names if they come back. Those keys now live in
 * `~/.forge/policy.yaml`, and this lock is what keeps Forge's own writers from editing
 * them while a feature is running — a llama.cpp install, `/chatMode`, a remote toggle
 * — and what closes the `setx` route that would otherwise point the next start at a
 * policy file inside a workspace.
 *
 * What the lock DOES and does NOT do, because the toast, `/config`, the README and
 * `docs/COMMANDS.md` all have to say it the same way:
 *
 * - It stops Forge's own writers being used as a proxy for the agent: every feature
 *   that edits a policy key asks `policyFileIsLocked` first and refuses.
 * - It stops accidental edits — the owner's blunt write, and any in-place write.
 * - It does NOT stop a process running as this user. The owner of a file can always
 *   rewrite its permissions (`icacls … /reset`, which is what `unlockPolicyFile`
 *   runs, needs no elevation), and `~/.forge` grants this user "delete child", so a
 *   script can rename a new file over the locked one: measured in
 *   `test/integration/PolicyLockFile.test.ts`, which pins that a locked file is
 *   still rename-replaceable on Windows. Against the agent, the owner-only argument
 *   guard in `src/tools/ownerPaths.ts` is the only thing in the way, and a script
 *   that computes the path at run time gets past even that.
 *
 * The real wall — an elevated, owner-run move of the file into a folder owned by
 * Administrators that the user cannot delete from — is proposal P4 in
 * `docs/plans/SECURITY_SIMPLIFICATION_PLAN.md` §4, left for the owner and NOT built
 * here, so no phase 4 code may assume the lock covers replacement or an ACL change.
 *
 * The commands are the owner's and Forge never runs either on its own: a lock the
 * protected code could set could also be undone by it, which is the point of locking.
 * `docs/plans/SECURITY_SIMPLIFICATION_PLAN.md` §4 keeps the rule: create = the lock
 * command, delete = the unlock command, "pause" = unlock, and the state lives on the
 * file, not in memory, so a crash or a window death cannot leave Forge believing
 * something the file contradicts. Every report here is read back FROM the file after
 * the change, and the writability half is measured by opening the file the way the
 * next Forge write would, not by trusting `icacls`'s text or the read-only attribute.
 *
 * vscode-free: the commands live in `nativeCommands.ts`, but the state is useful to
 * plain node (tests, the remote runtime) and must not need an editor to answer.
 */

export type PolicyLockState = 'absent' | 'locked' | 'unlocked';

export interface PolicyLockReport {
  policyPath: string;
  state: PolicyLockState;
  /** Whether THIS process can open the file for write right now — the same test the
   *  next Forge write will make, so the report cannot say "unlocked" about a file
   *  Forge is about to fail to write.
   */
  writableByForge: boolean;
  /** The ACL as the OS reports it: `icacls`'s own lines on Windows, the mode
   *  elsewhere. Shown to the owner verbatim, because a summary is what hides a
   *  permission nobody intended.
   */
  detail: string;
  /** Whose read-only the lock makes it, as the OS names that account. */
  grantedTo?: string;
}

/**
 * A command runner the tests can replace. It returns what the real tool returns —
 * stdout, stderr and the exit code as text — because this file's answer comes out of
 * `icacls`'s lines: a fake that returned a tidy object would hide a real output this
 * parser cannot read.
 */
export type LockCommandRunner = (
  program: string,
  args: string[],
) => { status: number; stdout: string; stderr: string };

const DEFAULT_RUN: LockCommandRunner = (program, args) => {
  const result = cp.spawnSync(program, args, { encoding: 'utf8' });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
};

/** `C:/Windows/System32/…` rather than a bare `icacls`: PATH is whatever the process
 *  that started this window put in front of it, and on this machine a Git Bash PATH
 *  puts an MSYS `whoami` first — one that prints only the user name and rejects the
 *  arguments below. That is how the first version of this file granted the lock to
 *  the computer account instead of the user, and made the owner's own read fail.
 */
function system32(tool: string): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:/Windows';
  return path.join(root, 'System32', tool);
}

/**
 * The current user's SID, and the fully qualified name `whoami` pairs with it.
 *
 * The lock grants read to the SID, not to a name, for two reasons measured on this
 * machine: `icacls` resolves a bare name that collides with a domain or computer
 * account to the wrong principal, and `whoami`'s plain output is not fully
 * qualified here. A SID cannot be ambiguous, and `icacls` still prints the resolved
 * account name in the listing it gives the owner, so nothing less readable reaches
 * them.
 */
function currentUserAccount(run: LockCommandRunner): { sid: string; name: string } | undefined {
  const result = run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  if (result.status !== 0) return undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    const parts = line.split(',').map((part) => part.trim().replace(/^"|"$/g, ''));
    const sid = parts.at(-1);
    if (!sid || !sid.startsWith('S-1-')) continue;
    return { sid, name: parts[0] ?? '' };
  }
  return undefined;
}

/** The `icacls` line that speaks for this user, matched by SID first and then by the
 *  name `whoami` reported: `icacls` prints a resolved name when it can resolve the
 *  SID and the raw SID when it cannot, so a listing may use either. Empty when no
 *  line names this user — an ACL that says nothing about them is the folder's
 *  default, not a grant of their own.
 */
function lineForAccount(output: string, account: { sid: string; name: string }): string {
  const needleSid = account.sid.toLowerCase();
  const needleName = account.name.toLowerCase();
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    if (lower.includes(needleSid)) return text;
    if (needleName && lower.includes(needleName)) return text;
  }
  return '';
}

/** Ask the file, not its ACL text: open it read-write without truncating, and close
 *  it. This is the permission the next Forge write will need, so a report built from
 *  it cannot disagree with what Forge is about to do. `fs.access` with `W_OK` would
 *  look at the read-only attribute on Windows instead of the ACL, and `icacls`'s
 *  text says what the DACL grants on paper, not what this process can get.
 *
 *  It is not the whole truth either, and the direction it is wrong in matters: on
 *  Windows this returns false for a file we locked, yet a RENAME onto that same file
 *  still succeeds, because the parent folder grants "delete child" and that grant
 *  outranks the file's own read-only entry. Measured on this machine: `Set-Content`
 *  and `fs.writeFileSync` fail with EACCES while `fs.renameSync` over the same file
 *  succeeds. So this function answers "may I modify this file in place", which is
 *  what Forge's writer has to ask before it starts, and it is not a promise that the
 *  file cannot be replaced from a folder this user may write in.
 */
function canOpenForWrite(filePath: string): boolean {
  let handle: number | undefined;
  try {
    handle = fs.openSync(filePath, 'r+');
    return true;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/**
 * Is the policy file locked, asked cheaply and freshly: one open attempt, no
 * subprocess, no cached answer.
 *
 * `ConfigWriter` and the migration ask this BEFORE they start, rather than letting
 * the ACL stop them halfway, for the reason in `canOpenForWrite`: a Windows folder
 * that grants "delete child" lets this user rename a new file over a read-only one,
 * so the ACL alone does not stop Forge's own atomic writer — measured, not assumed.
 * Checking first is also what makes the refusal say something useful: the unlock
 * command, instead of a bare `EPERM: rename` naming a temp file the owner has never
 * seen. And it is what makes the lock mean what the plan says it means: a locked
 * policy file cannot be changed by the code that is supposed to be governed by it,
 * so a feature cannot be used as a proxy for editing the owner's permissions.
 */
export function policyFileIsLocked(policyPath: string): boolean {
  return fs.existsSync(policyPath) && !canOpenForWrite(policyPath);
}

/** The one sentence every refused policy write carries, whether the refusal comes
 *  from this check or from the file system refusing the write itself.
 */
export function policyLockedMessage(policyPath: string): string {
  return (
    `Forge: ${policyPath} is locked, so this write was refused. Run\n` +
    '"Forge: Unlock policy.yaml", make the change, then run "Forge: Lock policy.yaml"\n' +
    'again. Forge does not fall back to writing config.yaml: the key belongs in the\n' +
    'policy file, and writing it into the file an agent can edit would undo the split.\n' +
    "The lock stops Forge's own writers and accidental edits. A program running as you\n" +
    'can always unlock the file or replace it, so unlock it to make a change rather\n' +
    'than writing around the lock.'
  );
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  return line || 'no message';
}

function requireExisting(policyPath: string): void {
  if (fs.existsSync(policyPath)) return;
  throw new Error(
    `Forge: ${policyPath} does not exist, so there is nothing to lock.\n` +
      'Run "Forge: Move security settings to policy.yaml" first: it creates the file from\n' +
      'the security keys config.yaml is holding, and then this command can protect it.',
  );
}

export interface PolicyLockDeps {
  /** Only for tests: a fake for `icacls`/`whoami`, returning their real output. */
  run?: LockCommandRunner;
}

/** What the policy file is right now, read from the file itself. */
export function readPolicyLockState(
  policyPath: string,
  deps: PolicyLockDeps = {},
): PolicyLockReport {
  if (!fs.existsSync(policyPath)) {
    return {
      policyPath,
      state: 'absent',
      writableByForge: false,
      detail: 'the file does not exist',
    };
  }
  const run = deps.run ?? DEFAULT_RUN;
  const writable = canOpenForWrite(policyPath);
  if (process.platform === 'win32') {
    const listing = run(system32('icacls.exe'), [policyPath]);
    const account = currentUserAccount(run);
    const report: PolicyLockReport = {
      policyPath,
      state: writable ? 'unlocked' : 'locked',
      writableByForge: writable,
      detail:
        listing.status === 0
          ? listing.stdout.trim()
          : `(icacls failed: ${firstLine(listing.stderr)})`,
    };
    if (account && listing.status === 0) {
      // The name comes from `whoami`, not from the listing: `icacls` may print this
      // account as a SID, as a resolved name, or as a continuation line whose head
      // still carries the file name, and a report that quoted the listing would
      // quote whichever of those happened to appear.
      const line = lineForAccount(listing.stdout, account);
      if (line) report.grantedTo = account.name;
    }
    return report;
  }
  const mode = fs.statSync(policyPath).mode & 0o7777;
  return {
    policyPath,
    state: writable ? 'unlocked' : 'locked',
    writableByForge: writable,
    detail: `mode ${mode.toString(8).padStart(4, '0')}`,
  };
}

/** One sentence for the owner, from the report: what the file is, and the way back.
 *  `/config` shows this, and so does each command, because the state is the thing the
 *  owner needs before they decide which command to run next.
 */
export function policyLockSentence(report: PolicyLockReport): string {
  if (report.state === 'absent') {
    return (
      'policy.yaml does not exist, so the security settings are still inside config.yaml. ' +
      'Run "Forge: Move security settings to policy.yaml" to split them out.'
    );
  }
  if (report.state === 'locked') {
    return (
      `policy.yaml is LOCKED${report.grantedTo ? ` (read-only for ${report.grantedTo})` : ''}: ` +
      'Forge can read it but cannot write it, so no Forge feature can edit your rules ' +
      'while it works. Run "Forge: Unlock policy.yaml" to edit it, and lock it again ' +
      "when you are done. Forge does not fall back to config.yaml. This guards Forge's " +
      'own writers and accidental edits: a program running as you can still unlock or ' +
      'replace the file.'
    );
  }
  return (
    'policy.yaml is unlocked: this process can write it, so anything this user runs can ' +
    'too, including a script that rewrites your rules. Run "Forge: Lock policy.yaml" to ' +
    "stop Forge's own writers and accidental edits — it will not stop a program running " +
    'as you, which can always unlock the file or replace it.'
  );
}

/**
 * `Forge: Lock policy.yaml`: read-only for this user, so an in-place write is refused
 * and only an elevated prompt (Administrators) or SYSTEM can write the file in place.
 *
 * `icacls <file> /inheritance:r /grant:r *<sid>:R /grant:r *S-1-5-32-544:F
 * /grant:r *S-1-5-18:F /deny *<sid>:(DE)` — the plan's command, with two changes
 * that were measured rather than assumed.
 *
 * The user is spelled as a SID for the reason in `currentUserAccount`. The
 * `/deny …(DE)` is the one the plan did not have, and it is what makes the lock
 * real: an owner has DELETE on their own file implicitly, so a grant of read alone
 * does not stop them replacing it. Measured on this machine, without the deny ACE
 * `fs.renameSync` and Forge's own atomic writer SUCCEEDED over a "read-only"
 * policy.yaml, while `Set-Content` failed — so the lock would have stopped the
 * blunt write and let the sneaky one through, which is the same hole as an agent
 * writing a new file into `~/.forge` and moving it over the top. With the deny ACE,
 * deleting or moving THIS file fails for this user, read still works, and Administrators
 * and SYSTEM keep full control, so an elevated prompt is the way back, as planned.
 *
 * It is not the whole story, and the comment used to overstate it: the deny entry
 * covers the file itself, not a replacement. A rename of some other file INTO this
 * folder over the locked one still succeeds on Windows, because the parent's "delete
 * child" grant outranks the child's own entry — `test/integration/PolicyLockFile.test.ts`
 * measures it, and it is why `policyFileIsLocked` is asked before every Forge write
 * instead of trusting the ACL to stop `writeFileAtomicSync`.
 *
 * `/inheritance:r` is what removes the folder's "modify" grant; without it the
 * inherited entry would still let this user write, and the lock would report success
 * while doing nothing. On a POSIX file system the same effect is the write bits:
 * `chmod` them off, and the owner's tools and Forge alike are refused.
 */
export function lockPolicyFile(policyPath: string, deps: PolicyLockDeps = {}): PolicyLockReport {
  requireExisting(policyPath);
  const run = deps.run ?? DEFAULT_RUN;
  if (process.platform === 'win32') {
    const account = currentUserAccount(run);
    if (!account) {
      throw new Error(
        'Forge: could not ask who this user is (' +
          `"${system32('whoami.exe')} /user /fo csv /nh" failed), so it cannot grant the ` +
          'lock to the right account and will not guess one.',
      );
    }
    const result = run(system32('icacls.exe'), [
      policyPath,
      '/inheritance:r',
      '/grant:r',
      `*${account.sid}:R`,
      '/grant:r',
      '*S-1-5-32-544:F',
      '/grant:r',
      '*S-1-5-18:F',
      // The deny ACE has to come after the grants in this same call: `icacls` puts
      // explicit denials first in the canonical order whatever order they were
      // typed in, so one call is enough, and two calls would leave a window where
      // the file is read-only but still replaceable.
      '/deny',
      `*${account.sid}:(DE)`,
    ]);
    if (result.status !== 0) {
      throw new Error(
        `Forge: icacls refused to lock ${policyPath}:\n  ${firstLine(result.stderr || result.stdout)}`,
      );
    }
    const report = readPolicyLockState(policyPath, { run });
    if (report.state !== 'locked') {
      throw new Error(
        `Forge: icacls said it locked ${policyPath}, and the file disagrees — this process\n` +
          `can still open it for write. Its own lines say:\n${report.detail}\n` +
          'Something else (another grant, or a folder that propagates one) is holding the\n' +
          'file open. Forge reports what it found rather than reporting the lock it asked for.',
      );
    }
    return report.grantedTo ? report : { ...report, grantedTo: account.name };
  }
  const before = fs.statSync(policyPath).mode & 0o7777;
  fs.chmodSync(policyPath, before & ~0o222);
  const report = readPolicyLockState(policyPath, { run });
  if (report.state !== 'locked') {
    throw new Error(
      `Forge: chmod took the write bits off ${policyPath} and the file is still writable\n` +
        `(${report.detail}) — the file system is not applying modes here, most likely because\n` +
        'it is a mount mounted with a fixed mode (a network share, WSL drvfs with metadata off).',
    );
  }
  return report;
}

/**
 * `Forge: Unlock policy.yaml`: back to the folder's default permissions.
 *
 * `icacls <file> /reset` replaces the explicit entries with the inherited ones the
 * file would have had if nobody had touched it, which is what "unlocked" has to mean
 * here: the plan's ledger calls unlock the pause button, so it has to leave the file
 * writable by the owner's own tools, not merely writable by an elevated prompt. On a
 * POSIX file system the write bits go back to the owner.
 */
export function unlockPolicyFile(policyPath: string, deps: PolicyLockDeps = {}): PolicyLockReport {
  requireExisting(policyPath);
  const run = deps.run ?? DEFAULT_RUN;
  if (process.platform === 'win32') {
    const result = run(system32('icacls.exe'), [policyPath, '/reset']);
    if (result.status !== 0) {
      throw new Error(
        `Forge: icacls refused to unlock ${policyPath}:\n  ${firstLine(result.stderr || result.stdout)}`,
      );
    }
    const report = readPolicyLockState(policyPath, { run });
    if (report.state === 'locked') {
      throw new Error(
        `Forge: icacls said it reset ${policyPath}, and the file disagrees — this process\n` +
          `still cannot open it for write. Its own lines say:\n${report.detail}\n` +
          'Forge reports what it found rather than reporting the unlock it asked for.',
      );
    }
    return report;
  }
  const before = fs.statSync(policyPath).mode & 0o7777;
  fs.chmodSync(policyPath, before | 0o600);
  const report = readPolicyLockState(policyPath, { run });
  if (report.state !== 'unlocked') {
    throw new Error(
      `Forge: chmod gave ${policyPath} its owner write bits back and the file is still\n` +
        `not writable (${report.detail}) — the mount is not applying modes here.`,
    );
  }
  return report;
}
