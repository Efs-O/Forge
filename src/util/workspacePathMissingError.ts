/** A missing workspace path, with the original errno message and request. */
export class WorkspacePathMissingError extends Error {
  readonly code: 'ENOENT' | 'ENOTDIR';
  readonly requestedPath: string;
  readonly workspaceRoot: string | undefined;

  constructor(
    requestedPath: string,
    code: 'ENOENT' | 'ENOTDIR',
    message: string,
    workspaceRoot: string | undefined,
  ) {
    super(message);
    this.name = 'WorkspacePathMissingError';
    this.requestedPath = requestedPath;
    this.code = code;
    this.workspaceRoot = workspaceRoot;
  }
}
