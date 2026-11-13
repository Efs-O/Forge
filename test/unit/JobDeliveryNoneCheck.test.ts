import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobDelivery } from '../../src/jobs/JobDelivery';
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
