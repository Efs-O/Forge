import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterAll } from 'vitest';

/**
 * A hermetic fake CLI executable: a real, empty file whose basename infers as
 * `claude`, so `inferCliAgentName` accepts it and `resolveCliExecutable`
 * returns it without a PATH lookup. Call at a test file's top level: it
 * registers that file's `afterAll` to remove the folder.
 */
export function fakeClaudeCli(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fake-cli-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.writeFileSync(file, '');
  return file;
}

/** How the faked child behaves: `spawnError` reports a program that is not
 *  there, `exit` a program that starts and then leaves on its own. */
export interface FakeCliChildBehaviour {
  /** Reported instead of `spawn`, on the next tick, as a spawn failure is.
   *  The message defaults to what Node gives for that code. */
  spawnError?: { code: string; message?: string };
  /** Reported after `spawn`, and after `stderrText` has been read. */
  exit?: { code: number | null; signal?: string | null };
  /** Written to stderr as the child starts, so a failure report can show it. */
  stderrText?: string;
  /** What its stdin write callback receives. Defaults to EPIPE when
   *  `spawnError` is set — that is what a write to a stdin whose reader never
   *  existed reports — and to no error otherwise. */
  writeError?: boolean;
}

/** A faked CLI child for the two outcomes a real spawn produces and a test
 *  cannot make a fixture produce on demand: a program that is not there (the
 *  `error` ENOENT, plus the `write EPIPE` a write to its dead stdin gives), and
 *  a program that starts, writes something to stderr and exits non-zero.
 *  Each is reported the way the real process reports it — the real message
 *  shape, events on a later tick, real streams for stdout and stderr — because
 *  a fake that hands back what the code under test expects hides exactly the
 *  bugs these tests exist to catch. */
export function fakeCliChild(
  executable: string,
  behaviour: FakeCliChildBehaviour,
): { child: ChildProcess; writes: string[] } {
  const writes: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const failedToStart = behaviour.spawnError !== undefined;
  const writeFails = behaviour.writeError ?? failedToStart;
  // stdin is a real stream, so `writable` and `on('error')` behave as they do
  // on a child's pipe. Only the write is faked, because the answer a dead pipe
  // gives is the point: the callback reports EPIPE whether or not the process
  // ever existed, and nothing about the chunk is ever read back.
  const stdin = new PassThrough();
  Object.assign(stdin, {
    write: (chunk: unknown, callback?: (error?: Error | null) => void): boolean => {
      writes.push(String(chunk));
      process.nextTick(() => callback?.(writeFails ? errno('write EPIPE', 'EPIPE') : undefined));
      return true;
    },
  });
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    killed: false,
    // A kill is answered the way a real one is: on a later tick, as an exit
    // with no code and the signal that ended it.
    kill: (): boolean => {
      process.nextTick(() => {
        Object.assign(child, { exitCode: null, signalCode: 'SIGTERM' });
        child.emit('exit', null, 'SIGTERM');
        stdout.end();
        stderr.end();
      });
      return true;
    },
  });
  process.nextTick(() => {
    if (failedToStart) {
      const code = behaviour.spawnError!.code;
      child.emit(
        'error',
        errno(behaviour.spawnError!.message ?? `spawn ${executable} ${code}`, code),
      );
      stdout.end();
      stderr.end();
      return;
    }
    child.emit('spawn');
    if (behaviour.stderrText) stderr.write(behaviour.stderrText);
    if (behaviour.exit) {
      const { code, signal = null } = behaviour.exit;
      process.nextTick(() => {
        Object.assign(child, { exitCode: code, signalCode: signal });
        child.emit('exit', code, signal);
        stdout.end();
        stderr.end();
      });
    }
  });
  return { child, writes };
}

/** An error with the `code` a real OS error carries — the field the start
 *  failure message is built from. */
function errno(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
