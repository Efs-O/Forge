import * as os from 'os';
import { spawnCliProcess, terminateProcessTree, waitForCliProcessExit } from '../agents/cliProcess';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';

/** A `claude -p` turn that only calls SendMessage took ~6.5 s when measured. */
const RELAY_TIMEOUT_MS = 90_000;
const OUTPUT_TAIL_CHARS = 600;

/**
 * The documented-only escape hatch (`agent_bus.claude_transport: relay`): a
 * one-shot `claude -p` whose only tool is SendMessage passes the message on.
 * Costs a model call (~$0.10), so it is opt-in; the peer pipe is the default.
 * It runs in the home folder so no project CLAUDE.md inflates the call, and the
 * prompt goes through stdin so no shell quoting touches the message.
 */
export async function relayToClaude(
  cli: string,
  model: string,
  sessionName: string,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  const executable = await resolveCliExecutable(cli, 'claude');
  const proc = spawnCliProcess({
    executable,
    args: ['-p', '--model', model, '--allowedTools', 'SendMessage', '--output-format', 'text'],
    cwd: os.homedir(),
    stdin: 'pipe',
  });
  proc.stdin?.end(
    `Call the SendMessage tool exactly once: send the message below, verbatim, to the ` +
      `Claude session named "${sessionName}". Then answer with the single word SENT, or with ` +
      `FAILED and the reason.\n\n----- message -----\n${text}`,
  );
  let output = '';
  const keep = (chunk: Buffer): void => {
    output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS);
  };
  proc.stdout?.on('data', keep);
  proc.stderr?.on('data', keep);
  const kill = (): void => void terminateProcessTree(proc);
  const timer = setTimeout(kill, RELAY_TIMEOUT_MS);
  signal?.addEventListener('abort', kill, { once: true });
  try {
    const exit = await waitForCliProcessExit(proc);
    if (exit.error) throw exit.error;
    if (exit.code !== 0 || !/\bSENT\b/.test(output)) {
      throw new Error(
        `the claude relay did not confirm (exit ${exit.code ?? 'none'}): ${output.trim()}`,
      );
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
  }
}
