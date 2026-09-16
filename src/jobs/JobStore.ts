import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomicSync } from '../util/atomicWrite';
import {
  JobSchema,
  JobStateSchema,
  RunRowSchema,
  type Job,
  type JobFile,
  type JobState,
  type RunRow,
} from './jobSchema';

/** The default state for a job that has never run. */
export function defaultState(): JobState {
  return {
    last_run_at: null,
    last_ok_at: null,
    last_observation: null,
    consecutive_failures: 0,
    next_due_at: null,
    conversation_id: null,
    summary_pending: false,
  };
}

/**
 * The on-disk store for persistent agent jobs.
 *
 * Layout (D1): `~/.forge/jobs/` — one `<id>.json` per job (the definition),
 * its state in a separate `state/<id>.json`, and an append-only
 * `runs/<id>.jsonl` run log. The state is a separate file so a user edit of the
 * definition never races a run writing state. Deliberately outside
 * `~/.forge/sessions/` so notification-only runs never get titled, never enter
 * chat history, and are never swept by HalluScribe.
 *
 * All writes are atomic (`writeFileAtomicSync`): a crash mid-write must never
 * leave a half-written file that the next load cannot parse.
 */
export class JobStore {
  private readonly jobsDir: string;
  private readonly stateDir: string;
  private readonly runsDir: string;
  private readonly runRequests: string;
  private watcher: fs.FSWatcher | undefined;
  private watchDebounce: ReturnType<typeof setTimeout> | undefined;
  private onChangeCallback: (() => void) | undefined;

  constructor(jobsRoot?: string) {
    const root = jobsRoot ?? path.join(os.homedir(), '.forge', 'jobs');
    this.jobsDir = root;
    this.stateDir = path.join(root, 'state');
    this.runsDir = path.join(root, 'runs');
    this.runRequests = path.join(root, 'run_requests');
  }

  /** The jobs directory (for the lease and tests). */
  get root(): string {
    return this.jobsDir;
  }

  /** The directory holding `run_now` marker files (B2). */
  get runRequestsDir(): string {
    return this.runRequests;
  }

  /** Create the directory tree if it does not exist. */
  async ensureDirs(): Promise<void> {
    await fs.promises.mkdir(this.jobsDir, { recursive: true });
    await fs.promises.mkdir(this.stateDir, { recursive: true });
    await fs.promises.mkdir(this.runsDir, { recursive: true });
    await fs.promises.mkdir(this.runRequests, { recursive: true });
  }

  /**
   * Load all jobs (definition + state). A malformed file is reported (thrown)
   * rather than skipped silently: a corrupt job file is a real error the user
   * should see, not a job that quietly stops running. A job with no state file
   * yet gets a default state.
   */
  async loadAll(): Promise<JobFile[]> {
    await this.ensureDirs();
    const entries = await fs.promises.readdir(this.jobsDir, { withFileTypes: true });
    // The jobs root also holds the scheduler's lease file
    // (`jobs-scheduler.lease.json`), which is not a job. Skip it.
    const files = entries.filter(
      (e) => e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.lease.json'),
    );
    const jobs: JobFile[] = [];
    for (const file of files) {
      const full = path.join(this.jobsDir, file.name);
      const raw = await fs.promises.readFile(full, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `Forge: job file ${file.name} is not valid JSON: ${(err as Error).message}`,
        );
      }
      const result = JobSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(`Forge: job file ${file.name} is malformed: ${result.error.message}`);
      }
      const state = await this.readState(result.data.id);
      jobs.push({ job: result.data, state });
    }
    // Sort canonically (creation order, then id) so the list is deterministic
    // across calls and platforms: `readdir` order is not, and the Telegram
    // `/jobs` numbering and `/job <n>` resolution both depend on it.
    jobs.sort((a, b) =>
      a.job.created_at !== b.job.created_at
        ? a.job.created_at - b.job.created_at
        : a.job.id.localeCompare(b.job.id),
    );
    return jobs;
  }

  /** Load one job (definition + state). Returns undefined when it does not exist. */
  async load(id: string): Promise<JobFile | undefined> {
    const full = path.join(this.jobsDir, `${id}.json`);
    let raw: string;
    try {
      raw = await fs.promises.readFile(full, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const result = JobSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      throw new Error(`Forge: job file ${id}.json is malformed: ${result.error.message}`);
    }
    const state = await this.readState(id);
    return { job: result.data, state };
  }

  /** Save a job's definition atomically. */
  async saveJob(job: Job): Promise<void> {
    await this.ensureDirs();
    writeFileAtomicSync(path.join(this.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2));
  }

  /** Save a job's state atomically. */
  async saveState(id: string, state: JobState): Promise<void> {
    await this.ensureDirs();
    JobStateSchema.parse(state);
    writeFileAtomicSync(path.join(this.stateDir, `${id}.json`), JSON.stringify(state, null, 2));
  }

  /**
   * Atomically patch a job's state: read the current state, apply `patch`, and
   * write it back with no await between the read and the write. The read and
   * write are both synchronous, so a concurrent state write (e.g. the
   * scheduler recording a run) cannot land in the gap and be clobbered — the
   * lost-update race that a `load`-then-`saveState` pair has. Used by the
   * discuss chat to set `conversation_id` without clobbering a run that
   * finished in the meantime.
   */
  patchState(id: string, patch: Partial<JobState>): void {
    const full = path.join(this.stateDir, `${id}.json`);
    let raw: string;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') raw = JSON.stringify(defaultState());
      else throw err;
    }
    let current: JobState;
    try {
      const result = JobStateSchema.safeParse(JSON.parse(raw));
      // State corruption is recoverable everywhere else in this store: a
      // malformed state merely makes the next job run establish a new
      // baseline.  Keep patchState consistent with readState.
      current = result.success ? result.data : defaultState();
    } catch (err) {
      if (err instanceof SyntaxError) current = defaultState();
      else throw err;
    }
    const next = JobStateSchema.parse({ ...current, ...patch });
    writeFileAtomicSync(full, `${JSON.stringify(next, null, 2)}\n`);
  }

  /** Read a job's state, or a default when the file is absent. */
  private async readState(id: string): Promise<JobState> {
    const full = path.join(this.stateDir, `${id}.json`);
    let raw: string;
    try {
      raw = await fs.promises.readFile(full, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultState();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt (non-JSON) state file is recoverable: the definition is
      // intact, and a lost state just means the job re-baselines on its next run.
      return defaultState();
    }
    const result = JobStateSchema.safeParse(parsed);
    if (!result.success) {
      return defaultState();
    }
    return result.data;
  }

  /** Delete a job's definition, state, run log, and any pending run request. */
  async delete(id: string): Promise<void> {
    for (const full of [
      path.join(this.jobsDir, `${id}.json`),
      path.join(this.stateDir, `${id}.json`),
      path.join(this.runsDir, `${id}.jsonl`),
      path.join(this.runRequests, id),
    ]) {
      await fs.promises.unlink(full).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
    }
  }

  /**
   * Append a run row to the job's run log. The log is append-only: a row is
   * never rewritten, so a crash mid-run cannot lose the previous row.
   */
  async appendRun(id: string, row: RunRow): Promise<void> {
    await this.ensureDirs();
    RunRowSchema.parse(row);
    const full = path.join(this.runsDir, `${id}.jsonl`);
    const line = JSON.stringify(row) + '\n';
    const handle = await fs.promises.open(full, 'a');
    try {
      await handle.writeFile(line, 'utf8');
    } finally {
      await handle.close();
    }
  }

  /** Read the run log for a job, oldest first. Empty when no runs yet. */
  async readRuns(id: string): Promise<RunRow[]> {
    const full = path.join(this.runsDir, `${id}.jsonl`);
    let raw: string;
    try {
      raw = await fs.promises.readFile(full, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => RunRowSchema.parse(JSON.parse(line)));
  }

  /**
   * Write a `run_now` marker for a job (B2). The marker is a file in
   * `run_requests/`; the scheduler consumes it on its next tick, so a
   * `run_now` issued from a window that does not hold the lease still runs the
   * job in the lease holder. The marker is idempotent: writing it again before
   * the scheduler consumes it does not double-run the job.
   */
  async requestRun(id: string): Promise<void> {
    await this.ensureDirs();
    const full = path.join(this.runRequests, `${id}`);
    await fs.promises
      .writeFile(full, `requested ${Date.now()}\n`, { flag: 'wx' })
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      });
  }

  /**
   * Consume every pending `run_now` marker, returning the job ids (deduplicated,
   * in the order the markers were written). The markers are deleted as they are
   * consumed, so a job is run at most once per marker. An unreadable or
   * malformed marker is skipped, not fatal.
   */
  async consumeRunRequests(): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.runRequests, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name) continue;
      // The marker file name is the job id verbatim (requestRun writes it with no
      // extension), so use it directly — job ids may contain a dot, so any
      // extension-stripping would corrupt them.
      ids.push(entry.name);
      await fs.promises
        .unlink(path.join(this.runRequests, entry.name))
        .catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
        });
    }
    return ids;
  }

  /**
   * Watch the jobs directory for changes (a `manage_jobs` edit from any
   * window). Debounced 1s so a burst of writes coalesces into one callback.
   * The callback is invoked with no arguments; the caller reloads.
   */
  watch(onChange: () => void): void {
    this.onChangeCallback = onChange;
    void this.ensureDirs();
    this.watcher = fs.watch(this.jobsDir, () => {
      if (this.watchDebounce) return;
      this.watchDebounce = setTimeout(() => {
        this.watchDebounce = undefined;
        this.onChangeCallback?.();
      }, 1000);
    });
  }

  /** Stop watching. */
  unwatch(): void {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
    this.onChangeCallback = undefined;
  }
}
