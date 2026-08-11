import * as path from 'path';
import { z } from 'zod';

export const CHECKPOINT_MANIFEST_VERSION = 1 as const;

function isSafeRelativePath(value: string): boolean {
  if (!value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  const topLevel = segments[0]?.toLowerCase();
  return topLevel !== '.forge' && !topLevel?.startsWith('.forge-');
}

const relativePathSchema = z.string().refine(isSafeRelativePath, 'unsafe checkpoint path');
const modeSchema = z.number().int().nonnegative();

const storedFileSchema = z
  .object({
    kind: z.literal('file'),
    relativePath: relativePathSchema,
    blobPath: z.string().regex(/^blobs\/[0-9a-f]{64}\.bin$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
    mode: modeSchema,
  })
  .strict();

const storedDirectorySchema = z
  .object({
    kind: z.literal('directory'),
    relativePath: relativePathSchema,
    mode: modeSchema,
  })
  .strict();

const storedSymlinkSchema = z
  .object({
    kind: z.literal('symlink'),
    relativePath: relativePathSchema,
    target: z.string(),
    linkType: z.enum(['file', 'dir', 'junction']),
  })
  .strict();

export const storedCheckpointEntrySchema = z.discriminatedUnion('kind', [
  storedFileSchema,
  storedDirectorySchema,
  storedSymlinkSchema,
]);

export type StoredCheckpointEntry = z.infer<typeof storedCheckpointEntrySchema>;

export const committedCheckpointManifestSchema = z
  .object({
    version: z.literal(CHECKPOINT_MANIFEST_VERSION),
    status: z.literal('committed'),
    turnId: z.string().min(1),
    workspaceRoot: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    originalEntries: z.array(storedCheckpointEntrySchema),
    createdPaths: z.array(relativePathSchema),
  })
  .strict();

export type CommittedCheckpointManifest = z.infer<typeof committedCheckpointManifestSchema>;

export interface DiskCheckpointReference {
  checkpointDir: string;
  manifestPath: string;
  workspaceRoot: string;
  changedPaths: string[];
}

export function toManifestPath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

export function fromManifestPath(relativePath: string): string {
  if (!isSafeRelativePath(relativePath))
    throw new Error('Checkpoint manifest contains unsafe path');
  return relativePath.split('/').join(path.sep);
}

export function parseCommittedManifest(raw: string): CommittedCheckpointManifest {
  return committedCheckpointManifestSchema.parse(JSON.parse(raw) as unknown);
}
