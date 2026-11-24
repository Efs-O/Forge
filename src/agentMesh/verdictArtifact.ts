import * as fs from 'fs';
import * as path from 'path';
import type { BusPaths } from '../agentBus/agentBus';
import { readEvents, EXCHANGES_LOG_NAME, type ExchangeEvent } from './exchangeLog';
import { writeFileAtomicSync } from '../util/atomicWrite';

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
export function retainVerdict(
  root: string,
  source: string,
  exchangeId: string,
  replace = false,
): string {
  const target = verdictArtifactPath(root, exchangeId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (replace) {
      writeFileAtomicSync(target, fs.readFileSync(source));
      fs.unlinkSync(source);
      return target;
    }
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

// ---------------------------------------------------------------------------
// Which retained answers are still WAITING, and for whom
// ---------------------------------------------------------------------------

/** How long an answer keeps being announced. The same 24 hours the exchange log
 *  itself gives an exchange (`DEFAULT_TTL_MS` there): past that the exchange
 *  ages out of the board, and a notice nobody has read for a day is noise. */
export const WAITING_VERDICT_MAX_AGE_MS = 24 * 60 * 60_000;

/** Every retained answer's `verdict` detail carries this substring — the
 *  not-live path, the failed-turn path, the cancelled-turn path, and the
 *  recovery route's `recovery reply retained for read-verdict`. A delivered
 *  answer says `delivered to the live sender session` instead, so the same
 *  substring decides retained-vs-delivered without a second table. */
const RETAINED_DETAIL = 'retained for read-verdict';

/** One answer a session has not seen live. Derived on every call: this is a
 *  report, not a thing stored. */
export interface WaitingVerdict {
  exchangeId: string;
  /** The session the exchange's `accepted` row recorded. The only party this
   *  answer may be announced to. */
  senderSessionId: string;
  /** The sender alias the exchange recorded (`claude`, `codex`, `copilot`):
   *  the `<name>` a `read-verdict` needs, and the kind a live delivery takes. */
  from: string;
  conversationId?: string;
  /** The chat title Forge has for it; the conversation id when the caller's
   *  resolver did not know the title; the exchange id when the exchange named no
   *  chat at all. */
  chatLabel: string;
  /** The `verdict` event's timestamp — the age the notice window counts from. */
  verdictTs: number;
}

/** Facts one exchange's events establish, gathered in one pass. */
interface ExchangeFacts {
  from?: string;
  conversation?: string;
  /** Every session an `accepted` row named. Normally one; a re-accept writes a
   *  second row, and either is the sender. */
  acceptedSessions: Set<string>;
  /** The newest `verdict` event by log order — the last word Forge recorded on
   *  whether this answer reached its session. */
  latestVerdict?: ExchangeEvent;
  latestVerdictSeq: number;
}

/**
 * The answers that are waiting for a session: retained on disk, recorded as
 * this session's, last word says retained rather than delivered, and less than
 * 24 hours old. Everything in this file's folder and the exchange log beside
 * it, so it lives here: `retainVerdict` writes the artifact, `authorizeRecipient`
 * already joins it with the log, and nothing else may grow a second opinion
 * about what "unread" means.
 *
 * `senderSessionId` names the session to report to; `undefined` means every
 * session, which is what a window starting up needs before it can work out
 * which of them it holds a link for (it filters the result by its own links).
 * An exchange no `accepted` row attributed to any session is never listed —
 * there is nobody to announce to, and guessing from the alias would announce
 * to the wrong Claude session of three.
 */
export function waitingVerdictsForSession(
  root: string,
  senderSessionId?: string,
  now: number = Date.now(),
  chatTitleFor?: (conversationId: string) => string | undefined,
): WaitingVerdict[] {
  const facts = new Map<string, ExchangeFacts>();
  for (const event of readEvents(path.join(root, EXCHANGES_LOG_NAME))) {
    const known = facts.get(event.exchangeId) ?? {
      acceptedSessions: new Set<string>(),
      latestVerdictSeq: -1,
    };
    if (known.from === undefined) known.from = event.from;
    if (known.conversation === undefined && event.conversation !== undefined)
      known.conversation = event.conversation;
    if (event.state === 'accepted' && event.senderSessionId !== undefined)
      known.acceptedSessions.add(event.senderSessionId);
    if (
      event.type === 'verdict' &&
      (known.latestVerdict === undefined || event.seq > known.latestVerdictSeq)
    ) {
      known.latestVerdict = event;
      known.latestVerdictSeq = event.seq;
    }
    facts.set(event.exchangeId, known);
  }
  const waiting: WaitingVerdict[] = [];
  for (const [exchangeId, known] of facts) {
    if (senderSessionId === undefined) {
      if (known.acceptedSessions.size === 0) continue;
    } else if (!known.acceptedSessions.has(senderSessionId)) {
      continue;
    }
    const verdict = known.latestVerdict;
    if (verdict === undefined) continue;
    // The last word only: a recovery route that delivered an answer an earlier
    // event had retained must stop it being announced, and the artifact lives
    // through that delivery, so the artifact check alone would not catch it.
    if (!verdict.detail?.includes(RETAINED_DETAIL)) continue;
    if (now - verdict.ts >= WAITING_VERDICT_MAX_AGE_MS) continue;
    // Acking deletes the artifact, so a missing file is an answered one. The id
    // is checked before it names a file: a log line is somebody else's input.
    if (!EXCHANGE_ID.test(exchangeId)) continue;
    if (!fs.existsSync(verdictArtifactPath(root, exchangeId))) continue;
    const conversationId = known.conversation;
    waiting.push({
      exchangeId,
      senderSessionId: senderSessionId ?? [...known.acceptedSessions][0],
      from: known.from ?? '',
      ...(conversationId === undefined ? {} : { conversationId }),
      chatLabel:
        (conversationId === undefined ? undefined : chatTitleFor?.(conversationId)) ??
        conversationId ??
        exchangeId,
      verdictTs: verdict.ts,
    });
  }
  return waiting.sort(
    (a, b) => a.verdictTs - b.verdictTs || a.exchangeId.localeCompare(b.exchangeId),
  );
}

/**
 * The sentence a waiting answer is announced with. Startup delivers these words
 * live; `forge.sh` prints the same sentence with its own `forge.sh: ` prefix and
 * the name the caller typed, so the two paths cannot drift apart.
 */
export function waitingVerdictNoticeSentence(
  verdict: Pick<WaitingVerdict, 'chatLabel' | 'exchangeId' | 'from'>,
): string {
  return (
    `An answer is waiting for you from chat "${verdict.chatLabel}" (exchange ${verdict.exchangeId}), ` +
    `not seen live. Read it with: forge.sh read-verdict ${verdict.from} ${verdict.exchangeId}`
  );
}
