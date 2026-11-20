/**
 * The "file changed since you read it" reminder (`event_reminders.file_changed`).
 *
 * Tips sit at the top of the context, where a long transcript and a heavy
 * quantization both take their pull away. The 2026-11-20 session scan counted 41
 * `edit_file` failures whose whole cause was that the file had moved since the
 * read the `old_str` was copied from — and the error only arrives after the
 * failure. This is the note at the decision point instead: when Forge can SEE
 * that a file this chat read has changed on disk, and can see that nothing this
 * chat ran wrote it, it says so once, at the next tool-round gap.
 *
 * The rule that keeps it honest: a reminder fires only on an event Forge can
 * see, never on a guess about which tool comes next, and every doubtful case
 * resolves toward silence. A wrong reminder costs the model a re-read it did not
 * need; a false one teaches it to ignore the true ones. So a `shell` call
 * re-stats everything it might have touched (a change made by an outside actor
 * during that call is missed ON PURPOSE), a failed `read_file` records nothing,
 * and a tool that names its paths (`edit_file`, `write_file`, `move_file`) only
 * re-stats the ones it named.
 *
 * State is per-conversation and in memory only, like the exfil flags in
 * `src/tools/exfilTaint.ts`: a window reload starts empty, so a reminder can
 * never claim to remember a read that is no longer in the transcript.
 * `clearConversationFileReads` drops a chat's entries with the chat itself.
 *
 * What it deliberately does NOT do: drain at turn start. A file the owner edits
 * between two turns is reported after the NEXT turn's first tool round, so an
 * `edit_file` in that first round can still fail once (`ToolCallingLoop` owns
 * turn start, and changing it is a separate plan).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatMessage } from '../llm/types';
import type { MidTurnDrainResult } from './MidTurnInbox';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import { realPathOfNearestAncestor } from '../util/realPath';
import { getLogger } from '../util/logger';

const log = getLogger();

/** One tracked read: what the file looked like when this chat read it. */
interface TrackedRead {
  /** The absolute path, as resolved from what the model asked for. */
  absolutePath: string;
  mtimeMs: number;
  size: number;
}

/** conversation id → key → what was read. The Map's insertion order is the
 *  order the paths were first read, which is the order the reminder names them. */
const readsByConversation = new Map<string, Map<string, TrackedRead>>();

/** Read at every record and every drain, so turning the setting on or off takes
 *  effect on the next round with no reload. Set once by `sidebarWiring.ts`. */
let isEnabled: () => boolean = () => false;

/** The config rule, kept in one place so the default is testable without a
 *  sidebar: ON unless the owner writes `file_changed: false`. An absent block or
 *  an absent key means on — an opt-in would simply never get turned on (owner,
 *  2026-11-20) — and the answer is re-read at every record and every drain. */
export function fileChangedReminderEnabledFor(
  config: { event_reminders?: { file_changed?: boolean } } | undefined,
): boolean {
  return config?.event_reminders?.file_changed !== false;
}

export function setFileChangeReminderEnabled(getter: () => boolean): void {
  isEnabled = getter;
}

function enabled(): boolean {
  try {
    return isEnabled() === true;
  } catch {
    // A config getter that throws is an off switch, never a crash inside a tool
    // round: a reminder is the least important thing in the turn.
    return false;
  }
}

/** The same file under two spellings is one entry: `A.ts` written as `a.ts` on
 *  Windows must not read as a change the model did not make. Real-pathed through
 *  the nearest existing ancestor (`realPath.ts`) rather than the file itself, so
 *  a path that has just been DELETED still lands on the key it was stored under
 *  — and a 8.3 spelling like `C:/Users/EFSOOF~1/...` lands on the long one. */
function trackKey(absolutePath: string): string {
  let real = absolutePath;
  try {
    real = realPathOfNearestAncestor(absolutePath);
  } catch {
    // A path the file system will not inspect (a permission error, a symlink
    // loop): the lexical path is the best answer, and the caller is about to
    // fail its stat anyway.
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** `(mtimeMs, size)` — the same pair `CheckpointFileIO.ts` and `fileSettle.ts`
 *  compare, and compared here by inequality. `undefined` for anything that is
 *  not a regular file right now. */
function statFile(absolutePath: string): { mtimeMs: number; size: number } | undefined {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return undefined;
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

/** The one path argument form that could throw: a relative path with no
 *  workspace folder open. A path that cannot be resolved is not recorded. */
function resolveOrNull(rawPath: string): string | undefined {
  try {
    return resolveWorkspacePath(rawPath);
  } catch {
    return undefined;
  }
}

/** What `ToolDispatch` reports after a call ran. Structural on purpose: the
 *  dispatch loop has these already, and the reminder must not depend on how a
 *  tool is registered, only on what this call was. */
export interface ToolCallFacts {
  toolName: string;
  /** The registered tool's permission — `'read'` means it cannot write files. */
  permission: string;
  /** True for a tool that declares a `mutation` (any file-writing tool). */
  hasMutation: boolean;
  args: Record<string, unknown>;
  /** The call's own result was a failure, so nothing it claimed to do happened. */
  resultFailed: boolean;
  /** `evaluation.mutationPaths` plus every path the tool reported through
   *  `beforeMutate` during this call: the paths it actually touched. */
  touchedPaths: readonly string[];
}

/**
 * Called once per finished tool call, from `ToolDispatch`, after the result is in
 * hand. A call that never ran (declined, refused by a preflight or a policy) is
 * not reported at all.
 */
export function noteToolCall(convId: string | undefined, call: ToolCallFacts): void {
  if (!enabled() || convId === undefined) return;
  // 1. A failed read read nothing: recording a snapshot of a file the model never
  //    saw would blame the next writer for a read that never happened.
  if (call.resultFailed && call.toolName === 'read_file') return;
  // 2. A read: remember how each requested file looks NOW, after the call.
  if (call.toolName === 'read_file') {
    recordReads(convId, call.args);
    return;
  }
  // 3. A file-writing tool: its own paths are the ones it could have changed, so
  //    those are re-stored and nothing else is touched.
  if (call.hasMutation) {
    retrackPaths(convId, call.touchedPaths);
    return;
  }
  // 4. Anything else that is not read-only (`shell`, git, jobs, process tools)
  //    can write files without naming them. Re-stat everything this chat read: a
  //    change an outside actor made DURING that call is then missed, which is the
  //    direction this feature chooses — silence over a reminder that is wrong.
  if (call.permission !== 'read') retrackAll(convId);
  // 5. Any other read-only tool: nothing.
}

/** Every path this read asked for: `path`, or each `reads[i].path`. */
function requestedReadPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof args['path'] === 'string') out.push(args['path']);
  const raw = args['reads'];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const itemPath = (item as { path?: unknown } | null)?.path;
      if (typeof itemPath === 'string') out.push(itemPath);
    }
  }
  return out;
}

function recordReads(convId: string, args: Record<string, unknown>): void {
  let tracked = readsByConversation.get(convId);
  for (const rawPath of requestedReadPaths(args)) {
    const absolutePath = resolveOrNull(rawPath);
    if (absolutePath === undefined) continue;
    const stat = statFile(absolutePath);
    // A missing item, a folder, a device: nothing to have read, nothing to blame.
    if (stat === undefined) continue;
    tracked ??= new Map<string, TrackedRead>();
    readsByConversation.set(convId, tracked);
    const key = trackKey(absolutePath);
    const existing = tracked.get(key);
    // Re-reading a file refreshes its snapshot and keeps its place in the order.
    if (existing) {
      existing.mtimeMs = stat.mtimeMs;
      existing.size = stat.size;
      continue;
    }
    tracked.set(key, { absolutePath, ...stat });
  }
}

/** Re-store what a file-writing tool said it touched; drop what it removed. */
function retrackPaths(convId: string, touchedPaths: readonly string[]): void {
  const tracked = readsByConversation.get(convId);
  if (!tracked || tracked.size === 0) return;
  for (const rawPath of touchedPaths) {
    const absolutePath = resolveOrNull(rawPath);
    if (absolutePath === undefined) continue;
    const key = trackKey(absolutePath);
    const entry = tracked.get(key);
    if (!entry) continue;
    const stat = statFile(absolutePath);
    if (stat === undefined) tracked.delete(key);
    else {
      entry.mtimeMs = stat.mtimeMs;
      entry.size = stat.size;
    }
  }
}

/** Re-stat every path this chat read: the fallback for a call that could have
 *  written any of them without saying which. */
function retrackAll(convId: string): void {
  const tracked = readsByConversation.get(convId);
  if (!tracked || tracked.size === 0) return;
  for (const [key, entry] of tracked) {
    const stat = statFile(entry.absolutePath);
    if (stat === undefined) tracked.delete(key);
    else {
      entry.mtimeMs = stat.mtimeMs;
      entry.size = stat.size;
    }
  }
}

/** A chat closed or `/clear`ed: its reads go with it. `undefined` clears all. */
export function clearConversationFileReads(conversationId?: string): void {
  if (conversationId === undefined) readsByConversation.clear();
  else readsByConversation.delete(conversationId);
}

/** Workspace-relative with `/` inside the workspace, absolute outside it — the
 *  spelling the model can hand straight back to a tool either way. */
function displayPath(absolutePath: string): string {
  const relative = vscode.workspace.asRelativePath(absolutePath);
  if (relative === absolutePath || path.isAbsolute(relative)) return absolutePath;
  return relative.replace(/\\/g, '/');
}

/** At most five names, so a mass rewrite on disk does not spend the context the
 *  reminder is meant to save. */
const MAX_NAMES = 5;

function reminderText(changedPaths: readonly string[]): string {
  const names = changedPaths.map(displayPath);
  if (names.length === 1)
    return (
      `[Forge] ${names[0]} changed on disk after you last read it. Read it again before ` +
      'you edit it: old_str copied from the earlier read may no longer match.'
    );
  const listed =
    names.length <= MAX_NAMES
      ? names.join(', ')
      : `${names.slice(0, MAX_NAMES).join(', ')} and ${names.length - MAX_NAMES} more`;
  return (
    `[Forge] These files changed on disk after you last read them: ${listed}. Read them ` +
    'again before you edit them: old_str copied from an earlier read may no longer match.'
  );
}

/**
 * The tell source. Registered always, so switching the setting on needs no
 * reload; it answers with nothing while the setting is off.
 *
 * Each changed path is re-stored (or dropped when it is gone) as it is reported,
 * so one change fires once: a second drain with nothing further changed is silent.
 */
export async function fileChangeSource(conversationId: string): Promise<MidTurnDrainResult> {
  if (!enabled()) return { messages: [] };
  const tracked = readsByConversation.get(conversationId);
  if (!tracked || tracked.size === 0) return { messages: [] };
  const changed: string[] = [];
  for (const [key, entry] of tracked) {
    const now = statFile(entry.absolutePath);
    if (now === undefined) {
      tracked.delete(key);
      changed.push(entry.absolutePath);
      continue;
    }
    if (now.mtimeMs !== entry.mtimeMs || now.size !== entry.size) {
      entry.mtimeMs = now.mtimeMs;
      entry.size = now.size;
      changed.push(entry.absolutePath);
    }
  }
  if (changed.length === 0) return { messages: [] };
  log.debug(`[file-change] conv=${conversationId} reported ${changed.length} changed file(s)`);
  const message: ChatMessage = {
    role: 'user',
    content: reminderText(changed),
    internal: true,
    midTurn: true,
  };
  return { messages: [message] };
}
