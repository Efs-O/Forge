/**
 * Host → webview file-diff preview shapes: the hunks a write tool produced and
 * the message that carries them to the sidebar.
 */

export type DiffLineKind = 'context' | 'added' | 'removed';
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiffMsg {
  type: 'fileDiff';
  /** Native tool-call id that produced this preview, when available. */
  toolCallId?: string;
  filePath: string;
  hunks: DiffHunk[] | null;
  isNew: boolean;
  isDeleted: boolean;
  conversationId?: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** Added and removed line counts of a diff; a null diff counts nothing. */
export function diffStats(hunks: DiffHunk[] | null | undefined): DiffStats {
  const lines = hunks?.flatMap((h) => h.lines) ?? [];
  return {
    added: lines.filter((l) => l.kind === 'added').length,
    removed: lines.filter((l) => l.kind === 'removed').length,
  };
}

/** The net change of a pending checkpoint: its files now against before the turn. */
export interface CheckpointStats {
  /** Files whose contents differ from the snapshot. */
  fileCount: number;
  added: number;
  removed: number;
  /** Changed files whose lines could not be counted (git unavailable). */
  uncountedFiles: number;
}
