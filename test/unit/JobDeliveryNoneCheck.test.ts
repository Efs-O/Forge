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

function delivery(): JobDelivery {
  return new JobDelivery({
    store: { load: async () => undefined } as never,
    outboxDir,
    notifyLocal: (text: string) => toasts.push(text),
    busy: () => undefined,
    summarize: undefined,
    now: () => Date.parse('2026-11-13T12:00:00Z'),
  });
}

const changed = { observation: '', changed: true, summary: 'no check (runs every tick)' };

const outboxFiles = (): string[] =>
  fs.readdirSync(outboxDir, { recursive: true, withFileTypes: true }).flatMap((entry) => (entry.isFile() ? [entry.name] : []));

describe('a check that observes nothing', () => {
  it('delivers nothing to notify, and says so in the count it returns', async () => {
    const result = await delivery().deliverForChange(
      jobOf({ kind: 'none' }, { kind: 'notify' }),
      changed,
    );
    expect(result).toEqual({ delivered: 0, summaryPending: false });
    expect(toasts).toEqual([]);
    expect(outboxFiles()).toEqual([]);
  });

  it('delivers nothing to summarize either — there is no observation to summarise', async () => {
    const result = await delivery().deliverForChange(
      jobOf({ kind: 'none' }, { kind: 'summarize', focus: ['releases'] }),
      changed,
    );
    expect(result).toEqual({ delivered: 0, summaryPending: false });
    expect(toasts).toEqual([]);
  });

  it('clears a summary left pending before the suppression existed, and delivers nothing', async () => {
    // A change recorded by an older build, or by a job since switched to `none`,
    // still sits in `summary_pending`; the idle tick must not deliver it.
    let patched: Record<string, unknown> | undefined;
    const store = {
      load: async () => undefined,
      loadAll: async () => [
        {
          job: jobOf({ kind: 'none' }, { kind: 'summarize', focus: ['releases'] }),
          state: {
            summary_pending: true,
            summary_failures: 0,
            summary_retry_at: null,
            last_observation: '',
          },
        },
      ],
      patchState: (_id: string, patch: Record<string, unknown>) => {
        patched = patch;
      },
    } as unknown as never;
    const d = new JobDelivery({
      store,
      outboxDir,
      notifyLocal: (text: string) => toasts.push(text),
      busy: () => undefined,
      summarize: async () => 'should never be asked',
      now: () => 0,
    });

    await d.processPendingSummaries();

    expect(toasts).toEqual([]);
    expect(outboxFiles()).toEqual([]);
    expect(patched).toMatchObject({ summary_pending: false });
  });
});

describe('a check that does observe something', () => {
  it('still delivers its summary when it changed', async () => {
    const result = await delivery().deliverForChange(
      jobOf({ kind: 'disk_space', path: os.tmpdir(), min_free_gb: 1 }, { kind: 'notify' }),
      { observation: '9', changed: true, summary: 'free space dropped' },
    );
    expect(result.delivered).toBe(1);
    expect(toasts).toEqual(['Job "lane 1": free space dropped']);
    expect(outboxFiles().length).toBe(1);
  });
});
