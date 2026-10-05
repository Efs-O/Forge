import * as fs from 'fs';
import * as path from 'path';
import type { BusPaths } from '../agentBus/agentBus';
import { readEvents } from './exchangeLog';

const EXCHANGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const VERDICT_DIR = 'verdicts';

export function verdictArtifactPath(root: string, exchangeId: string): string {
  if (!EXCHANGE_ID.test(exchangeId)) throw new Error('invalid exchange id');
  return path.join(root, VERDICT_DIR, `${exchangeId}.md`);
}

export function verdictEventId(exchangeId: string): string {
  if (!EXCHANGE_ID.test(exchangeId)) throw new Error('invalid exchange id');
  return `verdict-${exchangeId}`;
}

export function wakeEventId(exchangeId: string): string {
  if (!EXCHANGE_ID.test(exchangeId)) throw new Error('invalid exchange id');
  return `wake-${exchangeId}`;
}

/**
 * The writer has already renamed its .tmp to .verdict.md. Moving that complete
 * file into the artifact directory is atomic on the same filesystem. If the
 * process dies before the exchange event is appended, the poller finds it there
 * on restart and appends that event once.
 */
export function retainVerdict(root: string, source: string, exchangeId: string): string {
  const target = verdictArtifactPath(root, exchangeId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    // A previous poll moved the full copy already. The duplicate source is
    // expendable; the retained artifact remains readable until acknowledgment.
    fs.unlinkSync(source);
    return target;
  }
  fs.renameSync(source, target);
  return target;
}

export function pendingVerdictArtifacts(root: string): string[] {
  const dir = path.join(root, VERDICT_DIR);
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function authorizeRecipient(paths: BusPaths, exchangeId: string, from: string): void {
  verdictArtifactPath(paths.root, exchangeId);
  const events = readEvents(path.join(paths.root, 'exchanges.jsonl'));
  const first = events.find((event) => event.exchangeId === exchangeId);
  if (!first || first.from.toLowerCase() !== from.toLowerCase()) {
    throw new Error('no verdict for this sender and exchange');
  }
  if (!events.some((event) => event.eventId === verdictEventId(exchangeId))) {
    throw new Error('the verdict is not yet recorded for this exchange');
  }
}

/** Read never consumes the only full copy. */
export function readVerdictArtifact(paths: BusPaths, exchangeId: string, from: string): string {
  authorizeRecipient(paths, exchangeId, from);
  return fs.readFileSync(verdictArtifactPath(paths.root, exchangeId), 'utf8');
}

/** Acknowledgment is separate so a lost read response is safely retryable. */
export function acknowledgeVerdict(paths: BusPaths, exchangeId: string, from: string): void {
  authorizeRecipient(paths, exchangeId, from);
  fs.unlinkSync(verdictArtifactPath(paths.root, exchangeId));
}
