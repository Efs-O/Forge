/**
 * Closing a VS Code window from the phone.
 *
 * Two files in `remote-windows/`, and no more: the phone writes
 * `<windowId>.close-request.json`, the window it names reads its **own** file on
 * its own 5 s watch, and the outcome lands in `<windowId>.close-result.json` for
 * the window holding the lease to report — because a window that is not serving
 * cannot message the phone. They are files rather than fields of
 * `remote-state-v2.json` so a state write by any build cannot reach them.
 *
 * Every refusal is a fact only the target knows: whether it holds the lease
 * (closing it would leave the phone dark until someone reloads), whether it has
 * unsaved editors (`workbench.action.closeWindow` would open a modal save prompt
 * and leave the window open while the phone thinks it closed), and whether it is
 * busy — a running turn, a job, a delegated CLI agent or a pending approval.
 *
 * **Forge never closes a window on its own initiative and never force-closes.**
 * Both files expire at 60 s: a request nobody consumed never closes a window
 * late, and a result nobody could deliver dies with the tap that caused it
 * instead of arriving minutes later.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { HostId } from '../agentMesh/hostIdentity';
import { writeFileAtomic } from '../util/atomicWrite';
import {
  CloseRequestSchema,
  CloseResultSchema,
  closeRequestPath,
  closeResultPath,
  ensureDirectory,
  ownWindowId,
  readText,
  safeJson,
  windowRecordIsGone,
  type CloseChannel,
  type CloseRequest,
  type CloseResult,
} from './RemoteWindowRegistry';

/** How long an unconsumed close-request or an unreported close-result survives. */
export const CLOSE_TTL_MS = 60_000;

/**
 * How long a window that wrote “closed” is given before it stops believing its
 * own claim. `workbench.action.closeWindow` can be vetoed, and a window that is
 * still ticking 15 s later did not close — the phone must not be told a success
 * that did not happen, which is the difference between `closed` and `unknown`.
 *
 * Fifteen seconds plus the one 5 s tick it takes to notice is well inside
 * `CLOSE_TTL_MS`, so the rewritten `unknown` is reported long before the claim it
 * replaces could expire — which matters because `reportCloseResults` holds a
 * `closed` report while the target is still alive, so the phone hears exactly one
 * message about a vetoed close, never a success and then its reversal.
 */
export const STILL_ALIVE_REWRITE_MS = 15_000;

/** What the target window found in its own inbox, in the shape its handler needs. */
export type CloseRequestReading =
  | { kind: 'none' }
  | { kind: 'request'; request: CloseRequest }
  | { kind: 'expired'; request: CloseRequest }
  | { kind: 'gone-requester'; request: CloseRequest }
  | { kind: 'unreadable' };

/**
 * Read one window's own close-request, consuming what cannot be acted on.
 *
 * Expired, torn and requester-dead are consumed here and reported by the caller
 * rather than left in place: a file nobody consumed would have every later tick
 * read the same stale request, and a request whose owner is gone has nobody left
 * to tell. A torn request closes nothing — that is the ledger's answer for a
 * half-written file.
 */
export async function readCloseRequest(input: {
  directory: string;
  windowId: string;
  isHostAlive?: (recorded: HostId) => boolean;
  now?: () => number;
  ttlMs?: number;
}): Promise<CloseRequestReading> {
  const filePath = closeRequestPath(input.directory, input.windowId);
  const text = await readText(filePath);
  if (text === undefined) return { kind: 'none' };
  const parsed = CloseRequestSchema.safeParse(safeJson(text));
  if (!parsed.success) {
    // A half-written or foreign request names nobody Forge can act for: consume
    // it so it cannot be read again, and it never closes a window.
    await fs.unlink(filePath).catch(() => undefined);
    return { kind: 'unreadable' };
  }
  const request = parsed.data;
  const now = (input.now ?? Date.now)();
  if (now - request.requestedAt > (input.ttlMs ?? CLOSE_TTL_MS)) {
    await fs.unlink(filePath).catch(() => undefined);
    return { kind: 'expired', request };
  }
  if (input.isHostAlive && !input.isHostAlive(request.requester)) {
    await fs.unlink(filePath).catch(() => undefined);
    return { kind: 'gone-requester', request };
  }
  return { kind: 'request', request };
}

/** The window's own answer, written before it closes so a failed close can overwrite it. */
export async function writeCloseResult(result: CloseResult & { directory: string }): Promise<void> {
  await ensureDirectory(result.directory);
  await writeFileAtomic(
    closeResultPath(result.directory, result.windowId),
    `${JSON.stringify(result)}\n`,
    { mode: 0o600 },
  );
}

export interface CloseRunOutcome {
  outcome: 'none' | 'closed' | 'refused' | 'unknown';
  reason?: string;
}

/**
 * One window reading its own inbox and deciding. `holdsLease`, `hasUnsavedEditors`
 * and `busyReason` are injected because they are facts about this window that
 * nothing outside it can check, and the close itself is `closeWindow` — the same
 * command the owner would run from the command palette, run by the window on
 * itself.
 */
export async function runWindowClose(deps: {
  directory: string;
  windowId?: string;
  windowName: string;
  signal: AbortSignal;
  /** True while this window is answering the phone: closing it would leave the phone dark. */
  holdsLease: () => boolean;
  /** A dirty window would hit a modal save prompt and stay open while the phone thinks it closed. */
  hasUnsavedEditors?: () => boolean;
  /** A running turn, job, delegated CLI agent or pending approval, in the words the busy gate already produces. */
  busyReason?: () => string | undefined;
  closeWindow: () => Promise<void>;
  isHostAlive?: (recorded: HostId) => boolean;
  now?: () => number;
  /** Something worth putting on this owner's own screen when the phone has no chat to reach. */
  notifyLocal?: (message: string) => void;
}): Promise<CloseRunOutcome> {
  const windowId = deps.windowId ?? ownWindowId();
  const now = deps.now ? deps.now() : Date.now();
  await rewriteFalseSuccess(deps.directory, windowId, now);
  const reading = await readCloseRequest({
    directory: deps.directory,
    windowId,
    ...(deps.isHostAlive ? { isHostAlive: deps.isHostAlive } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (reading.kind === 'none') return { outcome: 'none' };
  // This window is going away: closing it again would change nothing, and the
  // request stays for a reader rather than being answered with a lie.
  if (deps.signal.aborted) return { outcome: 'none' };
  if (reading.kind === 'unreadable') {
    // A torn request carries no chat id, so there is nobody to tell on the phone.
    deps.notifyLocal?.('Forge remote: an unreadable close-request was discarded.');
    return { outcome: 'unknown', reason: 'the close-request could not be read' };
  }
  // Consume it here, before deciding: the ledger says a close-request is
  // consumed and unlinked by the window it names, and a request that survived
  // the decision would close the same window again on the next tick.
  await fs.unlink(closeRequestPath(deps.directory, windowId)).catch(() => undefined);
  const answer = async (
    outcome: CloseResult['outcome'],
    detail?: string,
  ): Promise<CloseRunOutcome> => {
    // Awaited, not fired and forgotten: a caller that has to report an outcome
    // should not have to guess whether the file that carries it exists yet.
    await writeCloseResult({
      directory: deps.directory,
      windowId,
      windowName: deps.windowName,
      outcome,
      ...(detail ? { detail } : {}),
      channel: reading.request.channel,
      chatId: reading.request.chatId,
      writtenAt: now,
    }).catch(() => undefined);
    return { outcome, ...(detail ? { reason: detail } : {}) };
  };
  if (reading.kind === 'expired')
    return answer(
      'refused',
      `nobody acted on it within ${Math.round(CLOSE_TTL_MS / 1000)} seconds, so nothing was closed`,
    );
  if (reading.kind === 'gone-requester')
    return answer('refused', 'the window that asked for it is gone');
  if (deps.holdsLease())
    return answer('refused', 'it is answering your phone, so closing it would cut you off');
  if (deps.hasUnsavedEditors?.())
    return answer('refused', 'it has unsaved editors, and a close would open a save prompt');
  const busy = deps.busyReason?.();
  if (busy) return answer('refused', busy);
  // Success is written first, because a window that closes cannot write afterwards:
  // a close that throws overwrites it with the refusal, and a window that dies
  // mid-close leaves the record for the next reader to report.
  await answer('closed');
  try {
    await deps.closeWindow();
  } catch (err) {
    return answer('refused', `could not close it: ${(err as Error).message}`);
  }
  return { outcome: 'closed' };
}

/**
 * Read the close outcomes this folder holds and send them to the chats that
 * asked, then clear them. Only the window holding the lease calls this: a window
 * that is not serving cannot message the phone.
 *
 * A `closed` claim is **held until the window it names is proven gone**, because
 * VS Code can veto a close — hot exit, a notebook or custom editor's save prompt
 * that `hasUnsavedEditors` cannot see, or an extension that refuses — and the
 * window that wrote the claim is the one window that cannot say so. While the
 * target is still alive the file stays for the next tick; the target's own tick
 * turns a `closed` claim it cannot keep into `unknown` at
 * `STILL_ALIVE_REWRITE_MS` (15 s), well inside this file's 60 s TTL, so a veto
 * reaches the phone as `unknown` rather than as a success the phone already
 * believed. `refused` and `unknown` are facts the target already knows, so they
 * go out at once.
 *
 * A result whose send fails stays for the next tick, and every file here expires
 * at 60 s, so a report nobody can receive dies with the request that caused it
 * instead of arriving late. An unreadable result is reported as `unknown`, never
 * as success.
 */
export async function reportCloseResults(deps: {
  directory: string;
  now?: () => number;
  /** Throws when delivery failed, which is what keeps the file for the next tick. */
  send: (channel: CloseChannel, chatId: string, text: string) => Promise<void>;
  ttlMs?: number;
  /** What proves a window gone. Production uses the real host check, as every
   *   other reader of this folder does; a test injects its own so it never
   *   touches a real process. */
  isHostAlive?: (recorded: HostId) => boolean;
  isPidAlive?: (pid: number) => boolean;
}): Promise<{ reported: number; expired: number; unreadable: number; waiting: number }> {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? CLOSE_TTL_MS;
  let reported = 0;
  let expired = 0;
  let unreadable = 0;
  let waiting = 0;
  for (const name of await listResults(deps.directory)) {
    const filePath = path.join(deps.directory, name);
    const text = await readText(filePath);
    if (text === undefined) continue;
    const parsed = CloseResultSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      unreadable += 1;
      // It names nobody Forge can reply to, so the only channel left is the
      // window's own screen; the file goes either way, or every tick would
      // re-read the same broken record.
      await fs.unlink(filePath).catch(() => undefined);
      continue;
    }
    if (now() - parsed.data.writtenAt > ttl) {
      // Nobody was serving while it waited: the phone has moved on, and a report
      // minutes after the tap is worse than none.
      await fs.unlink(filePath).catch(() => undefined);
      expired += 1;
      continue;
    }
    if (parsed.data.outcome === 'closed') {
      // Success is the one outcome this reader cannot take on trust: the window
      // that wrote it is the one window that cannot report it, and a close VS
      // Code vetoes looks exactly like a close that happened. Hold the report
      // until this reader can prove the window is gone — its record cleared at
      // `deactivate()`, or its host proven dead the way `readWindowRecords`
      // prunes — and the target's own 15 s rewrite turns a claim it cannot keep
      // into an `unknown` that does not need this proof.
      const gone = await windowRecordIsGone({
        directory: deps.directory,
        windowId: parsed.data.windowId,
        ...(deps.isHostAlive ? { isHostAlive: deps.isHostAlive } : {}),
        ...(deps.isPidAlive ? { isPidAlive: deps.isPidAlive } : {}),
      });
      if (!gone) {
        // Left in place, not consumed: the next tick asks again, and the file's
        // own 60 s is what finally stops it.
        waiting += 1;
        continue;
      }
    }
    try {
      await deps.send(parsed.data.channel, parsed.data.chatId, reportText(parsed.data));
    } catch {
      continue; // leave it: the next tick tries again until its 60 s runs out
    }
    await fs.unlink(filePath).catch(() => undefined);
    reported += 1;
  }
  return { reported, expired, unreadable, waiting };
}

/** The phone's sentence for one outcome; `unknown` is never phrased as success. */
export function reportText(result: CloseResult): string {
  if (result.outcome === 'closed') return `Forge closed ${result.windowName}.`;
  if (result.outcome === 'refused')
    return `Forge did not close ${result.windowName}: ${result.detail ?? 'it refused'}.`;
  return `Forge could not confirm whether ${result.windowName} closed: ${result.detail ?? 'no answer'}.`;
}

async function listResults(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory);
    return entries.filter((name) => name.endsWith('.close-result.json'));
  } catch {
    return [];
  }
}

/**
 * A window that wrote “closed” and is still here did not close: VS Code can veto
 * a close, and an extension host that is merely slow is not a closed window. The
 * claim is rewritten to `unknown` so the phone is never told a success that did
 * not happen — and a window that really closed never gets here, because it is
 * gone before this tick.
 */
async function rewriteFalseSuccess(
  directory: string,
  windowId: string,
  now: number,
): Promise<void> {
  const text = await readText(closeResultPath(directory, windowId));
  if (text === undefined) return;
  const parsed = CloseResultSchema.safeParse(safeJson(text));
  if (!parsed.success || parsed.data.outcome !== 'closed') return;
  // Give the window time to actually go: a close that is under way looks the
  // same as a veto for the first seconds.
  if (now - parsed.data.writtenAt < STILL_ALIVE_REWRITE_MS) return;
  await writeCloseResult({
    ...parsed.data,
    directory,
    outcome: 'unknown',
    detail: 'it is still open',
    writtenAt: now,
  }).catch(() => undefined);
}
