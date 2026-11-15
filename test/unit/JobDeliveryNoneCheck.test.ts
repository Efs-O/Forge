import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobDelivery } from '../../src/jobs/JobDelivery';
import { applyJobBackoff } from '../../src/jobs/jobRunLifecycle';
import type { Job } from '../../src/jobs/jobSchema';

/**
 * A job whose check can never observe anything reports a change on every tick,
 * and `on_change: notify` delivered that as a live notification each cycle — the
 * lab's student created one such job and got a phone ping every tick. `changed`
 * stays true (an `agent_task` must still run on schedule); the DELIVERY is what
 * a check with no observation cannot justify.
 *
 * The suppression is re-checked AFTER the model call that writes a summary,
 * because the owner can switch the job to `none` while that call is in flight.
 */
let outboxDir: string;
let toasts: string[];

beforeEach(() => {
  outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-deliver-none-'));
  toasts = [];
});
afterEach(() => {
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

const jobOf = (check: Job['check'], onChange: Job['on_change']): Job =>
  ({
    id: 'lane-1',
    name: 'lane 1',
    enabled: true,
    schedule: { kind: 'interval', minutes: 30 },
    check,
    on_change: onChange,
  }) as unknown as Job;

/** A store that answers with whatever `job` currently is — the live definition. */
function storeFor(
  job: Job,
  state?: Record<string, unknown>,
  patches: Array<Record<string, unknown>> = [],
) {
  return {
    load: async () => ({ job, state: state ?? {} }),
    loadAll: async () => [{ job, state: state ?? {} }],
    patchState: (_id: string, patch: Record<string, unknown>) => {
      patches.push(patch);
    },
    patches,
  };
}

function delivery(store: unknown, summarize?: () => Promise<string>): JobDelivery {
  return new JobDelivery({
    store: store as never,
    outboxDir,
    notifyLocal: (text: string) => toasts.push(text),
    busy: () => undefined,
    summarize,
    now: () => Date.parse('2026-11-13T12:00:00Z'),
  });
}

const changed = { observation: '', changed: true, summary: 'no check (runs every tick)' };

const outboxFiles = (): string[] =>
  fs
    .readdirSync(outboxDir, { recursive: true, withFileTypes: true })
    .flatMap((entry) => (entry.isFile() ? [entry.name] : []));

const noneCheck: Job['check'] = { kind: 'none' };
const watchingCheck: Job['check'] = { kind: 'disk_space', path: os.tmpdir(), min_free_gb: 1 };
const summarizeOn: Job['on_change'] = { kind: 'summarize', focus: ['releases'] };
const notifyOn: Job['on_change'] = { kind: 'notify' };

/** A pending summary as an older build or a switched job would leave it. */
const pending = {
  summary_pending: true,
  summary_failures: 0,
  summary_retry_at: null,
  last_observation: 'free space dropped',
};

describe('a check that observes nothing', () => {
  it('delivers nothing to notify, and says so in the count it returns', async () => {
    const result = await delivery(storeFor(jobOf(noneCheck, notifyOn))).deliverForChange(
      jobOf(noneCheck, notifyOn),
      changed,
    );
    expect(result).toEqual({ delivered: 0, summaryPending: false });
    expect(toasts).toEqual([]);
    expect(outboxFiles()).toEqual([]);
  });

  it('delivers nothing to summarize either — there is no observation to summarise', async () => {
    const result = await delivery(storeFor(jobOf(noneCheck, summarizeOn))).deliverForChange(
      jobOf(noneCheck, summarizeOn),
      changed,
    );
    expect(result).toEqual({ delivered: 0, summaryPending: false });
    expect(toasts).toEqual([]);
  });

  it('clears a summary left pending before the suppression existed, and delivers nothing', async () => {
    // A change recorded by an older build, or by a job since switched to `none`,
    // still sits in `summary_pending`; the idle tick must not deliver it.
    const job = jobOf(noneCheck, summarizeOn);
    const store = storeFor(job, pending);
    const d = delivery(store, async () => 'should never be asked');

    await d.processPendingSummaries();

    expect(toasts).toEqual([]);
    expect(outboxFiles()).toEqual([]);
    expect(store.patches.at(-1)).toMatchObject({ summary_pending: false });
  });
});

describe('the owner switches the job to none while the summary is being written', () => {
  it('does not deliver the summary the model already produced', async () => {
    const job = jobOf(watchingCheck, summarizeOn);
    const store = storeFor(job);
    const d = delivery(store, async () => {
      job.check = noneCheck; // the owner saves the new definition mid-call
      return 'a finished summary';
    });

    const result = await d.deliverForChange(job, {
      observation: 'free space dropped',
      changed: true,
      summary: 'ignored',
    });

    expect(result).toEqual({ delivered: 0, summaryPending: false });
    expect(toasts).toEqual([]);
    expect(outboxFiles()).toEqual([]);
  });

  it('does not deliver a finished pending summary either, and clears the flag', async () => {
    const job = jobOf(watchingCheck, summarizeOn);
    const store = storeFor(job, { ...pending });
    const d = delivery(store, async () => {
      job.check = noneCheck;
      return 'a finished summary';
    });

    await d.processPendingSummaries();

    expect(toasts).toEqual([]);
    expect(outboxFiles()).toEqual([]);
    expect(store.patches.at(-1)).toMatchObject({
      summary_pending: false,
      summary_failures: 0,
      summary_retry_at: null,
    });
  });

  it('sends no first-failure notice once the job stopped wanting delivery', async () => {
    const job = jobOf(watchingCheck, summarizeOn);
    const store = storeFor(job, { ...pending });
    const d = delivery(store, async () => {
      job.check = noneCheck;
      throw new Error('model busy');
    });

    await d.processPendingSummaries();

    expect(toasts).toEqual([]);
    expect(outboxFiles()).toEqual([]);
    // Nothing left to retry: the flag is cleared, not left to back off forever.
    expect(store.patches.at(-1)).toMatchObject({ summary_pending: false });
  });
});

describe('a job deleted while its summary is being written', () => {
  it('clears nothing on the success path: a deleted job owns no state file', async () => {
    const job = jobOf(watchingCheck, summarizeOn);
    const store = storeFor(job, { ...pending });
    // The owner deleted the job from another window while the model wrote. A
    // `patchState` here would write `defaultState()` and revive the state file
    // `delete()` removed — nothing enumerates `stateDir` to clean it again.
    const d = delivery({ ...store, load: async () => undefined }, async () => 'a finished summary');

    await d.processPendingSummaries();

    expect(toasts).toEqual([]);
    expect(outboxFiles()).toEqual([]);
    expect(store.patches).toEqual([]);
  });

  it('clears nothing and sends no failure notice when the attempt failed too', async () => {
    const job = jobOf(watchingCheck, summarizeOn);
    const store = storeFor(job, { ...pending });
    const d = delivery({ ...store, load: async () => undefined }, async () => {
      throw new Error('model busy');
    });

    await d.processPendingSummaries();

    expect(toasts).toEqual([]);
    expect(outboxFiles()).toEqual([]);
    expect(store.patches).toEqual([]);
  });
});

describe('a check that does observe something', () => {
  it('still delivers its summary when it changed', async () => {
    const job = jobOf(watchingCheck, notifyOn);
    const result = await delivery(storeFor(job)).deliverForChange(job, {
      observation: '9',
      changed: true,
      summary: 'free space dropped',
    });
    expect(result.delivered).toBe(1);
    expect(toasts).toEqual(['Job "lane 1": free space dropped']);
    expect(outboxFiles().length).toBe(1);
  });

  it('still delivers a pending summary while the job wants it (the re-check is not a mute)', async () => {
    const job = jobOf(watchingCheck, summarizeOn);
    const store = storeFor(job, { ...pending });
    const d = delivery(store, async () => 'free space dropped again');

    await d.processPendingSummaries();

    expect(toasts).toEqual(['Job "lane 1": free space dropped again']);
    expect(store.patches.at(-1)).toMatchObject({ summary_pending: false });
  });

  it('still sends the first-failure notice when the job is live', async () => {
    const job = jobOf(watchingCheck, summarizeOn);
    const store = storeFor(job, { ...pending });
    const d = delivery(store, async () => {
      throw new Error('model busy');
    });

    await d.processPendingSummaries();

    expect(toasts).toEqual([
      'Job "lane 1": could not summarize the recorded change (model busy); retrying with backoff.',
    ]);
    expect(store.patches.at(-1)).toMatchObject({ summary_failures: 1 });
  });
});

describe('a definition that predates the check that produced the result', () => {
  it('delivers nothing when the job became none while the check ran', async () => {
    // jobRunLifecycle hands down the definition it loaded before the check; the
    // store now reads `none`, and that is what must decide.
    const stale = jobOf(watchingCheck, notifyOn);
    const current = jobOf(noneCheck, notifyOn);
    const store = { load: async () => ({ job: current, state: {} }) } as never;

    const result = await delivery(store).deliverForChange(stale, {
      observation: '9',
      changed: true,
      summary: 'free space dropped',
    });

    expect(result).toEqual({ delivered: 0, summaryPending: false });
    expect(toasts).toEqual([]);
    expect(outboxFiles()).toEqual([]);
  });

  it('says the change is still pending when the job was paused mid-check (audit A8)', async () => {
    const stale = jobOf(watchingCheck, summarizeOn);
    const current = jobOf(watchingCheck, summarizeOn);
    current.enabled = false;
    const store = { load: async () => ({ job: current, state: {} }) } as never;

    const result = await delivery(store).deliverForChange(stale, {
      observation: '9',
      changed: true,
      summary: 'ignored',
    });

    // Not delivered, and not lost: the resume re-summarises the recorded change.
    expect(result).toEqual({ delivered: 0, summaryPending: true });
    expect(toasts).toEqual([]);
  });
});

describe('a pause is not a mute', () => {
  it('leaves a finished pending summary pending, sends nothing, and clears nothing', async () => {
    const job = jobOf(watchingCheck, summarizeOn);
    const store = storeFor(job, { ...pending });
    const d = delivery(store, async () => {
      job.enabled = false; // the owner paused the job while the model wrote
      return 'a finished summary';
    });

    await d.processPendingSummaries();

    expect(toasts).toEqual([]);
    expect(outboxFiles()).toEqual([]);
    // The A8 contract: a paused job keeps its recorded change for the resume.
    expect(store.patches).toEqual([]);
  });

  it('leaves a failed pending summary pending, sends no notice, and clears nothing', async () => {
    const job = jobOf(watchingCheck, summarizeOn);
    const store = storeFor(job, { ...pending });
    const d = delivery(store, async () => {
      job.enabled = false;
      throw new Error('model busy');
    });

    await d.processPendingSummaries();

    expect(toasts).toEqual([]);
    expect(store.patches).toEqual([]);
  });
});

describe('a failure notice for a job the owner stopped mid-run', () => {
  // The third consecutive failure is the one that reports `failing:`; the state
  // handed to applyJobBackoff is one short of it.
  const twoFailures = { consecutive_failures: 2 };
  const at = () => new Date('2026-11-13T12:00:00Z');

  function backoffStore(live: Job) {
    const patches: Array<Record<string, unknown>> = [];
    const runs: Array<Record<string, unknown>> = [];
    return {
      patches,
      runs,
      store: {
        patchState: (_id: string, patch: Record<string, unknown>) => patches.push(patch),
        appendRun: async (_id: string, row: Record<string, unknown>) => {
          runs.push(row);
        },
        load: async () => ({ job: live, state: twoFailures }),
      },
    };
  }

  it('says nothing for a check-only job switched to none, and still backs off', async () => {
    const stale = jobOf(watchingCheck, notifyOn);
    const harness = backoffStore(jobOf(noneCheck, notifyOn));

    await applyJobBackoff(
      harness.store as never,
      delivery(storeFor(jobOf(noneCheck, notifyOn))),
      at,
      { job: stale, state: twoFailures } as never,
      'check timed out',
    );

    expect(toasts).toEqual([]);
    expect(harness.patches.at(-1)).toMatchObject({ consecutive_failures: 3 });
    expect(harness.runs.at(-1)).toMatchObject({ outcome: 'skipped', delivered: 0 });
  });

  it('still reports for a job with an action — action reports are not suppressed', async () => {
    const withAction = (job: Job): Job => ({ ...job, action: { kind: 'agent_task', task: 'go' } });
    const harness = backoffStore(withAction(jobOf(noneCheck, notifyOn)));

    await applyJobBackoff(
      harness.store as never,
      delivery(storeFor(withAction(jobOf(noneCheck, notifyOn)))),
      at,
      { job: withAction(jobOf(watchingCheck, notifyOn)), state: twoFailures } as never,
      'the runner died',
    );

    expect(toasts).toEqual(['Job "lane 1": failing: the runner died']);
  });
});

describe('liveCheckTarget', () => {
  it('answers with the live job while it wants check notifications', async () => {
    const job = jobOf(watchingCheck, notifyOn);
    expect(await delivery(storeFor(job)).liveCheckTarget('lane-1')).toBe(job);
  });

  it('answers with nothing for a none check, a paused job, or a deleted one', async () => {
    expect(
      await delivery(storeFor(jobOf(noneCheck, notifyOn))).liveCheckTarget('lane-1'),
    ).toBeUndefined();
    const paused = jobOf(watchingCheck, notifyOn);
    paused.enabled = false;
    expect(await delivery(storeFor(paused)).liveCheckTarget('lane-1')).toBeUndefined();
    expect(
      await delivery({ load: async () => undefined } as never).liveCheckTarget('lane-1'),
    ).toBeUndefined();
  });
});
