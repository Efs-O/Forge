import * as os from 'os';
import { spawnCliProcess, terminateProcessTree, waitForCliProcessExit } from '../agents/cliProcess';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';

/** `codex queue` only hands the message to the open session; it returns fast. */
const QUEUE_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 600;

/**
 * The text Codex receives. It has no watcher and no README in its context, so
 * the reply contract travels with every question. Paths use forward slashes,
 * which both PowerShell and bash accept.
 */
export function codexMessage(
  replyPath: string,
  id: string,
  subject: string,
  question: string,
): string {
  const reply = replyPath.replace(/\\/g, '/');
  return (
    `[Forge agent bus, question ${id}] ${subject}\n\n${question}\n\n` +
    `Answer by writing your reply to ${reply}.tmp and then renaming it to ${reply} ` +
    '(the rename matters: the asker reads the file as soon as it exists). ' +
    'Also show your answer in this chat, prefixed "Codex says:".'
  );
}

/**
 * Deliver a message into an OPEN Codex session with `codex queue`. Proven with
 * Codex CLI 0.153.2: it arrives as a visible user message. It needs the session
 * open in a terminal with a writable sandbox that includes the bus folder;
 * nothing here can check that, so the caller can only report "no answer".
 * Throws with the CLI's own stderr when the queue call itself fails.
 */
export async function queueToCodex(
  cli: string,
  thread: string,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  const executable = await resolveCliExecutable(cli, 'codex');
  const proc = spawnCliProcess({
    executable,
    args: ['queue', '--thread', thread, '--message', message],
    cwd: os.homedir(),
  });
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
  });
  proc.stdout?.resume();
  const kill = (): void => void terminateProcessTree(proc);
  const timer = setTimeout(kill, QUEUE_TIMEOUT_MS);
  signal?.addEventListener('abort', kill, { once: true });
  try {
    const exit = await waitForCliProcessExit(proc);
    if (exit.error) throw exit.error;
    if (exit.code !== 0) {
      throw new Error(`codex queue exited with ${exit.code ?? 'no code'}: ${stderr.trim()}`);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
  }
}
