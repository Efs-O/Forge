import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const SHELL_OUTPUT_CAP = 30_000;
export const SHELL_OUTPUT_HEAD = 10_000;
export const SHELL_OUTPUT_TAIL = 20_000;
export const SHELL_OUTPUT_TTL_MS = 24 * 60 * 60 * 1000;

export interface CappedShellOutput {
  text: string;
  spillPath?: string;
  spillError?: string;
}

export function shellOutputRoot(home = os.homedir()): string {
  return path.join(home, '.forge', 'shell-output');
}

export async function capShellOutput(
  output: string,
  conversationId: string,
  toolCallId: string,
  cap = SHELL_OUTPUT_CAP,
  root = shellOutputRoot(),
): Promise<CappedShellOutput> {
  if (output.length <= cap) return { text: output };
  const head = Math.floor(cap / 3);
  const tail = cap - head;
  const safeConversation = conversationId.replace(/[^a-zA-Z0-9_-]/gu, '_');
  const safeCall = toolCallId.replace(/[^a-zA-Z0-9_-]/gu, '_');
  const spillPath = path.join(root, safeConversation, `${safeCall}.log`);
  const omitted = output.length - head - tail;
  let spillError: string | undefined;
  try {
    await fs.mkdir(path.dirname(spillPath), { recursive: true });
    await fs.writeFile(spillPath, output, 'utf8');
  } catch (error) {
    spillError = error instanceof Error ? error.message : String(error);
  }
  const hint = spillError
    ? `full output could not be saved: ${spillError}`
    : `Full output: ${spillPath} — search it with the shell (Select-String / rg / tail) instead of rerunning the command`;
  return {
    text: `${output.slice(0, head)}\n[… ${omitted} characters omitted. ${hint}]\n${output.slice(-tail)}`,
    ...(spillError ? { spillError } : { spillPath }),
  };
}

export async function sweepShellOutput(root = shellOutputRoot(), now = Date.now()): Promise<void> {
  const sweepDir = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await sweepDir(target);
      else if (entry.isFile()) {
        const stat = await fs.stat(target);
        if (now - stat.mtimeMs > SHELL_OUTPUT_TTL_MS) await fs.unlink(target);
      }
    }
    try {
      if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  await sweepDir(root);
}
