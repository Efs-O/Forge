/**
 * The durable half of a remote media job (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md):
 * one folder per job, one `job.json` in it, and the file list that folder is
 * willing to serve.
 *
 * Split from `remoteMediaJobs.ts` by the 500-line gate and by the concern: this
 * file answers "what does the store hold", and never decides whether a job may
 * run. Every row of the plan's state × lifecycle ledger that names a file lives
 * here; the queue and the gate that drive it live next door.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { writeFileAtomic } from '../util/atomicWrite';
import {
  UserNotificationService,
  type FileDeliveryResult,
} from '../sidebar/UserNotificationService';
import type { RemoteMediaJobStatus, RemoteMediaTool } from './remoteMediaContract';

export type JobState = RemoteMediaJobStatus['state'];
export type JobFile = NonNullable<RemoteMediaJobStatus['files']>[number];
/** A listed file plus where it sits inside the job folder, for the file route. */
export type StoredFile = JobFile & { path: string };

/** What `job.json` holds. `pid` + `started_at` are the dead-owner pair the
 *  sweep reads: a `queued` job whose owner window is gone can never start. */
export interface JobRecord {
  id: string;
  tool: RemoteMediaTool;
  client: string;
  state: JobState;
  pid: number;
  started_at: number;
  created_at: number;
  ended_at?: number;
  error?: string;
  result?: string;
  files?: StoredFile[];
  inputs?: string[];
}

export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
};

export function mimeOf(fileName: string): string {
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? 'text/plain';
}

export function kindOf(fileName: string): JobFile['kind'] {
  const mime = mimeOf(fileName);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'text';
}

/** A plain relative path: no drive, no root, no `..` segment. */
export function isPlainRelative(value: string): boolean {
  if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) return false;
  if (/^[\\/]/u.test(value)) return false;
  return !value.split(/[\\/]/u).includes('..');
}

export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read one job's record; a missing or corrupt `job.json` reads as undefined. */
export async function readRecord(dir: string): Promise<JobRecord | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, 'job.json'), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as JobRecord;
    return typeof parsed.id === 'string' && typeof parsed.state === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `writeFileAtomic`, so a crash leaves the old record or the new one, never a
 *  half-written one the sweep would then read as corrupt. */
export async function writeFileRecord(dir: string, record: JobRecord): Promise<void> {
  await writeFileAtomic(path.join(dir, 'job.json'), `${JSON.stringify(record, null, 2)}\n`);
}

/** The status the laptop sees, projected from the record: never more fields. */
export function statusOf(record: JobRecord): RemoteMediaJobStatus {
  return {
    id: record.id,
    state: record.state,
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.files === undefined
      ? {}
      : { files: record.files.map(({ name, bytes, kind }) => ({ name, bytes, kind })) }),
  };
}

/** One job: its folder, its abort, and the files its tool delivered. */
export class Job {
  readonly dir: string;
  readonly outDir: string;
  readonly inputsDir: string;
  readonly controller = new AbortController();
  /** Absolute paths the job-scoped tool "delivered"; recorded, sent nowhere. */
  readonly delivered = new Set<string>();
  state: JobState = 'queued';
  error: string | undefined;
  result: string | undefined;
  files: StoredFile[] | undefined;
  /** True once the job is terminal; a late handler answer is then ignored. */
  terminal = false;
  readonly createdAt = Date.now();

  constructor(
    readonly id: string,
    readonly tool: RemoteMediaTool,
    readonly client: string,
    readonly args: Record<string, unknown>,
    root: string,
  ) {
    this.dir = path.join(root, id);
    this.outDir = path.join(this.dir, 'out');
    this.inputsDir = path.join(this.dir, 'inputs');
  }
}

/** The record for a job's current state, as `job.json` holds it. */
export function recordOf(job: Job): JobRecord {
  return {
    id: job.id,
    tool: job.tool,
    client: job.client,
    state: job.state,
    pid: process.pid,
    started_at: job.createdAt,
    created_at: job.createdAt,
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.result === undefined ? {} : { result: job.result }),
    ...(job.files === undefined ? {} : { files: job.files }),
  };
}

/**
 * The job's stand-in for the window's notification service.
 *
 * A tool that "delivers" a file has produced a result the laptop can fetch;
 * nothing is sent to any desktop chat, because no desktop chat asked.
 */
export class JobNotifier extends UserNotificationService {
  constructor(private readonly record: (absolutePath: string) => void) {
    super();
  }

  override async deliverFile(
    event: Parameters<UserNotificationService['deliverFile']>[0],
  ): Promise<FileDeliveryResult> {
    this.record('imagePath' in event ? event.imagePath : event.mediaFile.workspacePath);
    return { kind: 'queued', chats: 0 };
  }

  override async deliverImageUnbudgeted(
    brake: 'confirm_each',
    event: Parameters<UserNotificationService['deliverImageUnbudgeted']>[1],
  ): Promise<number> {
    void brake;
    this.record(event.imagePath);
    return 0;
  }
}
