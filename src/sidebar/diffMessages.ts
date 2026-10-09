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
