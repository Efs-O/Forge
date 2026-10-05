import * as fs from 'fs/promises';
import { getBoardContext, getMeshOrchestrator } from '../agentMesh/meshContext';
import { verdictArtifactPath } from '../agentMesh/verdictArtifact';
import { latestStates, readEvents } from '../agentMesh/exchangeLog';
import * as path from 'path';

export type RemoteSessionTarget = 'claude' | 'codex' | 'copilot';

const WAIT_MS = 20 * 60_000;
const POLL_MS = 1_000;

/** Ask an existing session. The remote request id is also the mesh exchange id,
 * so a crash cannot make a redelivered Telegram update enqueue another turn. */
export async function askRemoteSession(
  target: RemoteSessionTarget,
  message: string,
  requestId: string,
  signal: AbortSignal,
): Promise<string> {
  const orchestrator = getMeshOrchestrator();
  if (!orchestrator) throw new Error('the agent mesh is not up in this window');
  const adapter = await orchestrator.resolveAdapter(target);
  if (!adapter) throw new Error(`no live session for "${target}"`);
  const outbound =
    `[Forge Telegram exchange ${requestId}] A paired user asks:\n\n${message}\n\n` +
    `Your final answer is delivered to that Telegram chat automatically. ` +
    `For an interim update, run forge.sh remote-notify ${target} ${requestId} with text on stdin. ` +
    `To ask the user a question and wait for /answer, run forge.sh remote-ask ${target} ${requestId} with the question on stdin. ` +
    `These commands route only to this exchange; do not include a chat id or bot token.`;

  if (adapter.observesTurns) {
    const wait = new AbortController();
    const abort = (): void => wait.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, WAIT_MS);
    let result: Awaited<ReturnType<typeof orchestrator.ask>>;
    try {
      if (signal.aborted) wait.abort();
      result = await orchestrator.ask(target, outbound, wait.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
    if (wait.signal.aborted && !signal.aborted)
      throw new Error(`${target} did not answer within 20 minutes`);
    if ('error' in result) throw new Error(result.error);
    if (result.status !== 'completed') {
      throw new Error(
        `${target} ${result.status}${result.finalText ? `: ${result.finalText}` : ''}`,
      );
    }
    const answer = result.finalText?.trim();
    if (!answer) throw new Error(`${target} completed without an answer`);
    return answer;
  }

  const root = getBoardContext()?.root;
  if (!root) throw new Error('the agent mesh has no verdict folder in this window');
  const outcome = await orchestrator.tell(target, outbound, {
    expectsReply: true,
    exchangeId: requestId,
  });
  if ('error' in outcome) throw new Error(outcome.error);
  return waitForRemoteVerdict(root, requestId, signal);
}

/** The mesh poller retains complete verdicts atomically; never consume its copy. */
export async function waitForRemoteVerdict(
  root: string,
  exchangeId: string,
  signal: AbortSignal,
  timeoutMs = WAIT_MS,
): Promise<string> {
  const artifact = verdictArtifactPath(root, exchangeId);
  const until = Date.now() + timeoutMs;
  let checks = 0;
  while (!signal.aborted && Date.now() < until) {
    try {
      const answer = (await fs.readFile(artifact, 'utf8')).trim();
      if (!answer) throw new Error('the agent returned an empty verdict');
      return answer;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (++checks % 5 === 0) {
      const state = latestStates(readEvents(path.join(root, 'exchanges.jsonl'))).get(exchangeId);
      if (state === 'rejected' || state === 'cancelled' || state === 'timeout') {
        throw new Error(`session exchange ${exchangeId} ended ${state} without an answer`);
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(POLL_MS, Math.max(1, until - Date.now())));
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }
  if (signal.aborted) throw new Error(`${exchangeId} was interrupted before the answer arrived`);
  throw new Error(`no answer from the session within ${Math.ceil(timeoutMs / 60_000)} minutes`);
}
