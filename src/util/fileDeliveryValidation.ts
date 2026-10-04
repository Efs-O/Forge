import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveRealWorkspacePath } from './WorkspacePaths';

export const MAX_FILE_DELIVERY_BYTES = 50 * 1024 * 1024;

export type FileDeliveryValidation =
  | { ok: true; absolutePath: string; size: number }
  | { ok: false; reason: 'path' | 'empty' | 'too-large'; size?: number };

export async function inspectFileForDelivery(
  absolutePath: string,
): Promise<FileDeliveryValidation> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absolutePath);
  } catch {
    return { ok: false, reason: 'path' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'path' };
  if (stat.size === 0) return { ok: false, reason: 'empty' };
  if (stat.size > MAX_FILE_DELIVERY_BYTES) {
    return { ok: false, reason: 'too-large', size: stat.size };
  }
  return { ok: true, absolutePath, size: stat.size };
}

export async function validateWorkspaceFileForDelivery(
  requestedPath: string,
  workspaceRoot: string | undefined,
): Promise<FileDeliveryValidation> {
  if (!requestedPath.trim() || path.isAbsolute(requestedPath)) {
    return { ok: false, reason: 'path' };
  }
  try {
    const absolutePath = await resolveRealWorkspacePath(requestedPath, workspaceRoot, {
      relativeOnly: true,
    });
    return await inspectFileForDelivery(absolutePath);
  } catch {
    return { ok: false, reason: 'path' };
  }
}

export function fileDeliveryRefusal(
  result: Extract<FileDeliveryValidation, { ok: false }>,
): string {
  switch (result.reason) {
    case 'path':
      return 'path must name an existing regular file inside the workspace';
    case 'empty':
      return 'cannot send an empty file';
    case 'too-large':
      return (
        `file is too large (${(result.size ?? 0).toLocaleString()} bytes; maximum is ` +
        `${MAX_FILE_DELIVERY_BYTES.toLocaleString()} bytes)`
      );
  }
}
