import type { JobFile } from './jobSchema';
import type { ModelJobAdmission } from './agentTaskAdmission';

export interface PendingModelAction {
  jobFile: JobFile;
  wasLate: boolean;
  runNow: boolean;
  /** Original due time, or the first deferral time on a retry. */
  orderAt: number;
}

export interface ModelActionRunner {
  run(jobFile: JobFile, wasLate: boolean, admission?: ModelJobAdmission): Promise<void>;
}

export interface ModelJobLaneHooks {
  onStart(): void;
  onFinish(): void;
  onError(error: unknown): void;
}

/** One admitted model action at a time; the admission wait itself owns no lane. */
export class JobModelLane {
  private activeJobId: string | undefined;

  get occupied(): boolean {
    return this.activeJobId !== undefined;
  }

  async process(
    candidates: PendingModelAction[],
    shouldStop: () => boolean,
    attempt: (candidate: PendingModelAction) => Promise<void>,
  ): Promise<void> {
    candidates.sort(
      (a, b) =>
        Number(b.runNow) - Number(a.runNow) ||
        a.orderAt - b.orderAt ||
        a.jobFile.job.id.localeCompare(b.jobFile.job.id),
    );
    for (const candidate of candidates) {
      if (this.occupied || shouldStop()) return;
      await attempt(candidate);
      if (this.occupied) return;
    }
  }

  async run(
    candidate: PendingModelAction,
    fresh: JobFile,
    runner: ModelActionRunner,
    hooks: ModelJobLaneHooks,
  ): Promise<boolean> {
    const id = fresh.job.id;
    hooks.onStart();
    let admitted = false;
    let resolveAdmission!: () => void;
    const admission = new Promise<void>((resolve) => (resolveAdmission = resolve));
    const onAdmitted = (): void => {
      if (admitted) return;
      admitted = true;
      this.activeJobId = id;
      resolveAdmission();
    };
    const runFile = {
      ...fresh,
      state: {
        ...candidate.jobFile.state,
        task_run: fresh.state.task_run,
      },
    };
    const run = runner.run(runFile, candidate.wasLate, {
      onAdmitted,
      allowDisabled: candidate.runNow,
    });
    void run.catch(hooks.onError);
    await Promise.race([
      admission,
      run.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    if (!admitted) {
      await run.catch(() => undefined);
      hooks.onFinish();
      return false;
    }
    const finish = (): void => {
      if (this.activeJobId === id) this.activeJobId = undefined;
      hooks.onFinish();
    };
    void run.then(finish, finish);
    return true;
  }
}
