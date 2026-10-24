import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RequestStatsRow } from './requestStats';
import { writeFileAtomic } from '../util/atomicWrite';
import { getLogger } from '../util/logger';

const TEMP_MAX_AGE_MS = 10 * 60_000;
const PRUNE_INTERVAL_MS = 60_000;
const log = getLogger();
let sequence = 0;

export function requestDumpsDirectory(): string {
  return path.join(os.homedir(), '.forge', 'requests');
}

export interface PruneRequestDumpsOptions {
  maxBytes?: number;
  now?: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isSafeConversationId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(id) && id !== '.' && id !== '..';
}

function warnFailure(message: string, error: unknown): void {
  if (isMissing(error)) return;
  log.warn(`[requestDump] ${message}: ${error instanceof Error ? error.message : String(error)}`);
}

interface DumpFile {
  directory: string;
  filename: string;
  filePath: string;
  size: number;
  sentAtMs: number | undefined;
}

function sentAtFromJson(raw: string, filename: string): number | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const sentAt = (value as Record<string, unknown>)['sent_at_ms'];
    return typeof sentAt === 'number' && Number.isFinite(sentAt) ? sentAt : undefined;
  } catch (error) {
    log.warn(
      `[requestDump] could not read sent_at_ms from ${filename}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** Prune expired/crash-leftover dumps, then enforce the configured byte cap. */
export async function pruneRequestDumps(
  root: string,
  options: PruneRequestDumpsOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  let folders: fs.Dirent[];
  try {
    folders = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    warnFailure('could not list dump folder', error);
    return;
  }

  const dumps: DumpFile[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const directory = path.join(root, folder.name);
    let files: fs.Dirent[];
    try {
      files = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      warnFailure(`could not list conversation folder ${folder.name}`, error);
      continue;
    }
    for (const file of files) {
      if (!file.isFile()) continue;
      const filePath = path.join(directory, file.name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (file.name.endsWith('.tmp')) {
          if (stat.mtimeMs < now - TEMP_MAX_AGE_MS) await fs.promises.unlink(filePath);
          continue;
        }
        const expiry = /^(\d+)-[^/]+\.json$/u.exec(file.name)?.[1];
        if (!expiry || Number(expiry) >= now) {
          if (file.name.endsWith('.json') && options.maxBytes !== undefined) {
            const raw = await fs.promises.readFile(filePath, 'utf8');
            dumps.push({
              directory,
              filename: file.name,
              filePath,
              size: stat.size,
              sentAtMs: sentAtFromJson(raw, file.name),
            });
          }
          continue;
        }
        await fs.promises.unlink(filePath);
      } catch (error) {
        warnFailure(`could not prune ${file.name}`, error);
      }
    }
  }

  if (options.maxBytes !== undefined) {
    let totalBytes = dumps.reduce((total, dump) => total + dump.size, 0);
    dumps.sort((a, b) => {
      if (a.sentAtMs !== undefined && b.sentAtMs !== undefined && a.sentAtMs !== b.sentAtMs) {
        return a.sentAtMs - b.sentAtMs;
      }
      return a.filename.localeCompare(b.filename);
    });
    for (const dump of dumps) {
      if (totalBytes <= options.maxBytes) break;
      try {
        await fs.promises.unlink(dump.filePath);
        totalBytes -= dump.size;
      } catch (error) {
        if (isMissing(error)) totalBytes -= dump.size;
        else warnFailure(`could not enforce size cap for ${dump.filename}`, error);
      }
    }
  }

  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const directory = path.join(root, folder.name);
    try {
      if ((await fs.promises.readdir(directory)).length === 0) {
        await fs.promises.rmdir(directory);
      }
    } catch (error) {
      if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
        warnFailure(`could not remove empty conversation folder ${folder.name}`, error);
      }
    }
  }
}

export interface RequestDumpInput {
  conversationId: string;
  request: string;
  url: string;
  model: string;
  sentAtMs: number;
  stats: RequestStatsRow;
}

export interface RequestDumpSettings {
  maxBytes: number;
  keepHours: number;
}

/** Queues disk work away from the client callback so it cannot delay a turn. */
export class RequestDumpWriter {
  private readonly disabledConversations = new Set<string>();
  private readonly writeWarnings = new Set<string>();
  private readonly oversizedWarnings = new Set<string>();
  private lastPrunedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly root = requestDumpsDirectory(),
    private readonly warn: (message: string) => void = (message) => log.warn(message),
  ) {}

  enqueue(input: RequestDumpInput, settings: RequestDumpSettings): void {
    if (this.disabledConversations.has(input.conversationId)) return;
    setImmediate(() => void this.write(input, settings));
  }

  private async write(input: RequestDumpInput, settings: RequestDumpSettings): Promise<void> {
    const id = input.conversationId;
    if (this.disabledConversations.has(id)) return;
    try {
      if (!isSafeConversationId(id)) throw new Error('invalid conversation id');
      const request = JSON.parse(input.request) as unknown;
      const expiresAtMs = input.sentAtMs + settings.keepHours * 60 * 60_000;
      const filename = `${expiresAtMs}-${process.pid}-${++sequence}.json`;
      const directory = path.join(this.root, id);
      const target = path.join(directory, filename);
      const content = JSON.stringify({
        request,
        url: input.url,
        model: input.model,
        conversationId: id,
        sent_at_ms: input.sentAtMs,
        stats: input.stats,
      });
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > settings.maxBytes) {
        if (!this.oversizedWarnings.has(id)) {
          this.oversizedWarnings.add(id);
          this.warn(
            `[requestDump] skipped oversized request dump for conversation ${id} (${bytes} bytes)`,
          );
        }
        return;
      }
      await fs.promises.mkdir(directory, { recursive: true });
      // The shared writer: it flushes the temp file through the same handle
      // before renaming, which this file's own temp-plus-rename did not, so a
      // power loss cannot leave a dump whose size is right and body is NUL.
      await writeFileAtomic(target, content);
    } catch (error) {
      this.disabledConversations.add(id);
      if (!this.writeWarnings.has(id)) {
        this.writeWarnings.add(id);
        this.warn(
          `[requestDump] disabled request dumps for conversation ${id} after write failure: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }

    const now = Date.now();
    if (now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.lastPrunedAt = now;
    try {
      await pruneRequestDumps(this.root, { maxBytes: settings.maxBytes, now });
    } catch (error) {
      warnFailure('post-write prune failed', error);
    }
  }
}

/** Remove all request bodies for a deleted conversation. */
export async function deleteRequestDumps(
  conversationId: string,
  root = requestDumpsDirectory(),
): Promise<void> {
  if (!isSafeConversationId(conversationId)) {
    log.warn('[requestDump] refused to delete dumps for an invalid conversation id');
    return;
  }
  try {
    const directory = path.join(root, conversationId);
    const files = await fs.promises.readdir(directory);
    for (const filename of files) {
      try {
        await fs.promises.unlink(path.join(directory, filename));
      } catch (error) {
        warnFailure(`could not delete ${filename} for conversation ${conversationId}`, error);
      }
    }
    try {
      await fs.promises.rmdir(directory);
    } catch (error) {
      if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
        warnFailure(`could not remove folder for conversation ${conversationId}`, error);
      }
    }
  } catch (error) {
    warnFailure(`could not delete request dumps for conversation ${conversationId}`, error);
  }
}
