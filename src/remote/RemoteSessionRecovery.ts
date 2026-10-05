import * as fs from 'fs/promises';
import * as path from 'path';
import { getBoardContext } from '../agentMesh/meshContext';
import { getLogger } from '../util/logger';
import type { RemoteOutboxDelivery } from './RemoteOutboxDelivery';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteInboundEvent } from './types';

const REPLY_DEADLINE_MS = 20 * 60_000;
const ANSWER_RETENTION_MS = 24 * 60 * 60_000;

/** Reconcile a dead window's unknown session request without resending its prompt. */
export function startRemoteSessionRecovery(
  store: RemoteRequestStore,
  channel: RemoteInboundEvent['channel'],
  outbox: RemoteOutboxDelivery,
  signal: AbortSignal,
  onError?: (message: string) => void,
): void {
  let active = false;
  let lastPrune = 0;
  const poll = async (): Promise<void> => {
    if (active || signal.aborted) return;
    active = true;
    try {
      const root = getBoardContext()?.root;
      if (root && Date.now() - lastPrune >= 60 * 60_000) {
        lastPrune = Date.now();
        await pruneRemoteAnswerFiles(root);
      }
      const requests = store.contactRead((state) =>
        state.requests.filter(
          (item) => item.channel === channel && item.sessionTarget && item.state === 'unknown',
        ),
      );
      for (const request of requests) {
        if (signal.aborted) return;
        let answer: string | undefined;
        if (root) {
          for (const file of [
            path.join(root, 'verdicts', `${request.id}.md`),
            path.join(root, 'outbox', `${request.id}.verdict.md`),
          ]) {
            try {
              answer = (await fs.readFile(file, 'utf8')).trim();
              break;
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            }
          }
        }
        if (!answer && Date.now() - request.updatedAt < REPLY_DEADLINE_MS) continue;
        if (signal.aborted || store.getRequest(request.id)?.state !== 'unknown') continue;
        const name = request.sessionTarget![0]!.toUpperCase() + request.sessionTarget!.slice(1);
        await store.finish(
          request.id,
          answer ? 'completed' : 'failed',
          answer
            ? { finalText: answer, notification: `${name} says:\n\n${answer}` }
            : {
                error: 'outcome unknown after window restart',
                notification: `${name} outcome is unknown after window restart; check that session before resending.`,
              },
        );
        outbox.kick();
      }
    } finally {
      active = false;
    }
  };
  const report = (error: unknown): void => {
    const message = `Forge remote session recovery failed: ${String(error)}`;
    getLogger().error(message, error);
    try {
      onError?.(message);
    } catch (reportError) {
      getLogger().error(message, reportError);
    }
  };
  const timer = setInterval(() => void poll().catch(report), 5_000);
  timer.unref?.();
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  void poll().catch(report);
}

async function pruneRemoteAnswerFiles(root: string): Promise<void> {
  const dir = path.join(root, 'remote-answers');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.md$/u.test(name)) continue;
    const file = path.join(dir, name);
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > ANSWER_RETENTION_MS) await fs.unlink(file);
  }
}
