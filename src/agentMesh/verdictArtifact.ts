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

/**
 * The writer has already written its complete file. Moving it into the
 * artifact directory is atomic on the same filesystem. Callers append the
 * `verdict-<id>` exchange event straight after, with no other await between:
 * a read is refused until that event exists, and nothing rescans this folder
 * on restart.
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

function authorizeRecipient(
  paths: BusPaths,
  exchangeId: string,
  from: string,
  senderSessionId?: string,
): void {
  verdictArtifactPath(paths.root, exchangeId);
  const events = readEvents(path.join(paths.root, 'exchanges.jsonl'));
  const first = events.find((event) => event.exchangeId === exchangeId);
  if (!first || first.from.toLowerCase() !== from.toLowerCase()) {
    throw new Error('no verdict for this sender and exchange');
  }
  // The reader's identity has to be exactly the one the exchange recorded —
  // the same, or neither. Two gaps used to sit in this check: a caller that
  // named `from=claude` and left its own id out passed for any Claude session's
  // exchange, and a caller that brought an id passed for an exchange that
  // recorded none. `forge.sh read-verdict`/`ack-verdict` send the
  // kind-specific identity for every agent name (`set_sender_identity`), so an
  // honest agent always presents the pair that matches: the relay records
  // `senderSessionId` in its `created` row, and an inbound reply records it in
  // its `accepted` row. An exchange with no recorded session stays readable by
  // a caller that presents none, as before.
  if (first.senderSessionId !== senderSessionId)
    throw new Error('no verdict for this session and exchange');
  if (!events.some((event) => event.eventId === verdictEventId(exchangeId))) {
    throw new Error('the verdict is not yet recorded for this exchange');
  }
}

/** Read never consumes the only full copy. */
export function readVerdictArtifact(
  paths: BusPaths,
  exchangeId: string,
  from: string,
  senderSessionId?: string,
): string {
  authorizeRecipient(paths, exchangeId, from, senderSessionId);
  return fs.readFileSync(verdictArtifactPath(paths.root, exchangeId), 'utf8');
}

/** Acknowledgment is separate so a lost read response is safely retryable. */
export function acknowledgeVerdict(
  paths: BusPaths,
  exchangeId: string,
  from: string,
  senderSessionId?: string,
): void {
  authorizeRecipient(paths, exchangeId, from, senderSessionId);
  fs.unlinkSync(verdictArtifactPath(paths.root, exchangeId));
}
