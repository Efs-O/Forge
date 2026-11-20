import * as fs from 'fs';
import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';
import { diffContents } from './DiffUtils';
import { isExistingDirectory } from './callDiffBase';
import type { CheckpointSession } from '../checkpoint/CheckpointStack';
import type { RecordedFileDiff } from './toolDispatchTypes';

/**
 * The card showing this call's change for ONE file, built from the pre-call
 * snapshot the checkpoint stack holds.
 *
 * It lives here rather than inside `ToolDispatch.ts` because that file sits at
 * the eslint `max-lines` cap and Phase 1 of `docs/plans/EVENT_REMINDERS_PLAN.md`
 * needs room in it; the behaviour is unchanged. The base is `callBase` (the
 * content just before this call, `callDiffBase.ts`), not the turn checkpoint, so
 * a second edit in one turn shows its own diff rather than the whole turn's.
 */
export function postFileDiff(
  /** Where the card goes: `ToolDispatch`'s own `post`, or the buffered one a
   *  parallel-read round uses. */
  post: (msg: HostToWebview) => void,
  /** Whichever snapshot set this call belongs to — the turn's checkpoint, or the
   *  stack when there is none. Both expose `readSnapshotContent`. */
  snapshots: Pick<CheckpointSession, 'readSnapshotContent'>,
  resolvedPath: string,
  callBase: Map<string, string | null> | undefined,
  convId?: string,
  toolCallId?: string,
  recordFileDiff?: (diff: RecordedFileDiff) => void,
): void {
  const beforeContent = snapshots.readSnapshotContent(resolvedPath);
  if (beforeContent === undefined) return;
  if (isExistingDirectory(resolvedPath)) return;
  const base = callBase?.has(resolvedPath) ? (callBase.get(resolvedPath) ?? null) : beforeContent;

  const isDeleted = !fs.existsSync(resolvedPath);
  const afterContent = isDeleted ? '' : fs.readFileSync(resolvedPath, 'utf8');
  const isNew = base === null;
  const hunks = isDeleted ? null : diffContents(base ?? '', afterContent);
  const relPath = vscode.workspace.asRelativePath(resolvedPath);
  if (toolCallId) {
    recordFileDiff?.({ toolCallId, filePath: relPath, hunks, isNew, isDeleted });
  }
  post({
    type: 'fileDiff',
    ...(toolCallId ? { toolCallId } : {}),
    filePath: relPath,
    hunks,
    isNew,
    isDeleted,
    ...(convId ? { conversationId: convId } : {}),
  });
}
