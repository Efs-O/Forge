import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { z } from 'zod';
import {
  osProcessStartMsAsync,
  START_TIME_TOLERANCE_MS,
  type HostId,
} from '../agentMesh/hostIdentity';
import { isProcessAlive } from '../util/processLiveness';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { getLogger } from '../util/logger';

const execFileAsync = promisify(execFile);
const EntrySchema = z.object({
  id: z.string().regex(/^exec-[0-9a-f-]+$/iu),
  pid: z.number().int().positive(),
  processStartedAt: z.number().positive(),
  command: z.string().min(1),
  args: z.array(z.string()),
  ownerPid: z.number().int().positive(),
  ownerStartedAt: z.number().positive(),
});

export type BackgroundRegistryEntry = z.infer<typeof EntrySchema>;

export interface BackgroundRegistryDeps {
  isAlive(pid: number): boolean;
  processStartMsAsync(pid: number): Promise<number | undefined>;
  killTree(pid: number): Promise<void>;
  owner: HostId | (() => Promise<HostId | undefined>);
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
}

/** Durable ownership records for processes that must be reaped after a killed extension host. */
export class BackgroundRegistry {
  constructor(
    private readonly directory = path.join(os.homedir(), '.forge', 'background-execs'),
    private readonly deps: BackgroundRegistryDeps = defaultDeps(),
  ) {}

  async register(
    entry: Omit<BackgroundRegistryEntry, 'ownerPid' | 'ownerStartedAt' | 'processStartedAt'> & {
      processStartedAt?: number;
    },
    isStillRunning: () => boolean = () => true,
  ): Promise<void> {
    try {
      const [processStartedAt, owner] = await Promise.all([
        entry.processStartedAt ?? this.deps.processStartMsAsync(entry.pid),
        typeof this.deps.owner === 'function' ? this.deps.owner() : this.deps.owner,
      ]);
      if (!isStillRunning()) return;
      if (processStartedAt === undefined || owner === undefined) {
        throw new Error('process or extension-host start time is unavailable');
      }
      const value = EntrySchema.parse({
        ...entry,
        processStartedAt,
        ownerPid: owner.pid,
        ownerStartedAt: owner.startedAt,
      });
      fs.mkdirSync(this.directory, { recursive: true });
      writeFileAtomicSync(this.filePath(value), `${JSON.stringify(value)}\n`);
    } catch (error) {
      this.deps.error(
        `Could not register background execution ${entry.id}: ${message(error)}. ` +
          'It will not be reaped if the extension host is killed.',
      );
    }
  }

  remove(entry: Pick<BackgroundRegistryEntry, 'id' | 'ownerPid'>): void {
    const file = path.join(this.directory, `${entry.ownerPid}-${entry.id}.json`);
    try {
      this.unlinkIfExists(file);
    } catch (error) {
      // A stale entry is safe: the next host verifies owner and child identities.
      this.deps.error(
        `Could not remove background execution registry entry ${entry.id}: ${message(error)}`,
      );
    }
  }

  private unlinkIfExists(file: string): void {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async reap(): Promise<void> {
    let files: string[];
    try {
      files = fs.readdirSync(this.directory).filter((name) => name.endsWith('.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of files) {
      const file = path.join(this.directory, name);
      let entry: BackgroundRegistryEntry;
      try {
        entry = EntrySchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch (error) {
        // Another window may have completed this entry after readdirSync.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        this.deps.warn(
          `Deleting unreadable background execution registry entry ${file}: ${message(error)}`,
        );
        this.unlinkIfExists(file);
        continue;
      }
      if (await this.ownerIsAlive(entry)) continue;
      if (this.deps.isAlive(entry.pid)) {
        const currentStart = await this.deps.processStartMsAsync(entry.pid);
        if (currentStart !== undefined && currentStart === entry.processStartedAt) {
          try {
            await this.deps.killTree(entry.pid);
            this.deps.info(
              `Reaped orphaned background execution ${entry.id} pid=${entry.pid} command=${entry.command}`,
            );
          } catch (error) {
            this.deps.warn(
              `Could not terminate verified background execution ${entry.id} pid=${entry.pid}: ${message(error)}`,
            );
          }
        } else {
          this.deps.warn(
            `Not killing background execution ${entry.id}: pid ${entry.pid} start time does not match or is unavailable.`,
          );
        }
      }
      this.unlinkIfExists(file);
    }
  }

  private async ownerIsAlive(entry: BackgroundRegistryEntry): Promise<boolean> {
    if (!this.deps.isAlive(entry.ownerPid)) return false;
    const currentStart = await this.deps.processStartMsAsync(entry.ownerPid);
    // Unknown identity is conservatively alive: an unverifiable owner must never be raced.
    return (
      currentStart === undefined ||
      Math.abs(currentStart - entry.ownerStartedAt) <= START_TIME_TOLERANCE_MS
    );
  }

  private filePath(entry: BackgroundRegistryEntry): string {
    return path.join(this.directory, `${entry.ownerPid}-${entry.id}.json`);
  }
}

function defaultDeps(): BackgroundRegistryDeps {
  let ownerStart: number | undefined;
  return {
    isAlive: isProcessAlive,
    processStartMsAsync: osProcessStartMsAsync,
    owner: async () => {
      ownerStart ??= await osProcessStartMsAsync(process.pid);
      return ownerStart === undefined ? undefined : { pid: process.pid, startedAt: ownerStart };
    },
    error: (line) => getLogger().error(line),
    warn: (line) => getLogger().warn(line),
    info: (line) => getLogger().info(line),
    killTree: killVerifiedProcessTree,
  };
}

async function killVerifiedProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      timeout: 5_000,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const backgroundRegistry = new BackgroundRegistry();
