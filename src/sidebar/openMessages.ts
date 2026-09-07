/**
 * Webview → host messages that ask VS Code to open something.
 *
 * A pair, and grouped for that reason: both hand a target to the editor rather
 * than changing any Forge state, and both must be able to fail visibly — a
 * transcript reference can outlive the file it names.
 */

export interface OpenFileMsg {
  type: 'openFile';
  path: string;
  /** 1-based line to reveal, from a `path:42` reference in the transcript. */
  line?: number;
  /** Ctrl/Cmd-click: open in the editor group beside the active one. */
  beside?: boolean;
}

/** Opens one stored chat attachment in VS Code's own viewer. */
export interface OpenAttachmentMsg {
  type: 'openAttachment';
  /** `<conversationId>/<file>`, as carried on the transcript row. */
  relativePath: string;
}
