import { TITLE_MAX_UNITS } from '../sidebar/conversationTitle';
import { getLogger } from '../util/logger';
import { nextDue } from './schedule';
import { nextDueWithBackoff } from './backoff';
import { CLEAR_PENDING, deferBusyTask, userQuietGate, USER_QUIET_MS } from './agentTaskAdmission';
import { gpuGateReason } from './gpuIdleGate';
import { JobDelivery } from './JobDelivery';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { Action, JobFile, RunRow } from './jobSchema';
import type { GpuGateConfig, ModelConfig } from '../config/types';
import type { GpuInfo } from '../system/systemProbes';
import type { JobStore } from './JobStore';
import {
  buildRetitleRequest,
  normalizeTitleKey,
  parseProposedTitle,
  pickRetitleCandidates,
  type RetitleCandidate,
  type RetitleConversation,
} from './retitleCandidates';
import { readRetitleRecords, type RetitleDirs } from './retitleRecords';

/**
 * The `retitle` action: a daily job that gives the chats still named after
 * their first prompt a name a person would search for.
 *
 * Two decisions from `docs/plans/V1_FINISH_PLAN.md` shape this file. The title
 * comes back from the model as a plain string and the host applies it — there
 * is no tool for the agent to call, so a job cannot rename something the filter
 * did not offer. And the read side goes through the store files rather than the
 * live sidebar: the job runs while the owner is doing something else, and a
 * chat it might disturb is exactly the one it must not touch.
 *
 * The write goes through `applyAutoTitle` on the host facade, which is the same
 * path the sidebar rename uses, so the in-memory list, the archive index and the
 * body files all move together — a job that wrote the JSON files itself would
 * be overwritten by the next save from the window.
 *
 * Reading those files is `retitleRecords.ts`; this file is the deciding half —
 * when a pass may run, what it asks the model, and what it reports back.
 */

/** The `retitle` action, narrowed from the discriminated union. */
export type RetitleAction = Extract<Action, { kind: 'retitle' }>;

export interface RetitleDeps {
  store: JobStore;
  host: () => ForgeHostFacade | undefined;
  /** This workspace's conversation stores; undefined when no folder is open. */
  dirs: () => RetitleDirs | undefined;
  /** One no-tools model call through the sidebar's own path (`runPromptToMarkdown`). */
  summarize: (prompt: string) => Promise<string>;
  /** The model when the action names none. */
  defaultModel: () => string | undefined;
  outboxDir: string;
  notifyLocal: (text: string) => void;
  /** The reason a turn is outstanding anywhere in this window. */
  busy: () => string | undefined;
  now: () => number;
  /** A skipped row when this model is a CLI agent jobs may not use. */
  cliAgentSkip?: (model: string, at: number, late: boolean) => RunRow | undefined;
  /** The "this window runs an older build than the installed one" sentence. */
  staleWindow?: () => string | undefined;
  gpuGate?: {
    config: () => GpuGateConfig | undefined;
    model: (name: string) => ModelConfig | undefined;
    loadedModels: () => readonly ModelConfig[];
    signal?: () => AbortSignal;
    probe?: (signal?: AbortSignal) => Promise<GpuInfo[]>;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
}

/** What one run did, for the run row and the toast. */
interface RetitleRunOutcome {
  ok: boolean;
  scanned: number;
  offered: number;
  applied: number;
  refused: number;
  sentence: string;
}

export class RetitleRunner {
  private readonly deps: RetitleDeps;
  private readonly delivery: JobDelivery;

  constructor(deps: RetitleDeps) {
    this.deps = deps;
    this.delivery = new JobDelivery({
      store: deps.store,
      outboxDir: deps.outboxDir,
      notifyLocal: deps.notifyLocal,
      busy: deps.busy,
      summarize: undefined,
      now: deps.now,
    });
  }

  /** Run one retitle pass: gate, scan, ask, apply, report. */
  async run(jobFile: JobFile, wasLate: boolean): Promise<void> {
    const { job } = jobFile;
    const action = job.action;
    if (action?.kind !== 'retitle') return;
    const startedAt = this.deps.now();
    const host = this.deps.host();
    const dirs = this.deps.dirs();
    if (!host || !dirs || typeof host.applyAutoTitle !== 'function') {
      await this.finish(jobFile, action, wasLate, startedAt, {
        ok: false,
        scanned: 0,
        offered: 0,
        applied: 0,
        refused: 0,
        sentence: 'retitle is not wired (no host facade, no storage folder for this workspace)',
      });
      return;
    }

    let model = '';
    try {
      model = action.model ?? this.deps.defaultModel() ?? '';
    } catch (err) {
      await this.finish(jobFile, action, wasLate, startedAt, {
        ok: false,
        scanned: 0,
        offered: 0,
        applied: 0,
        refused: 0,
        sentence: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const blocked = this.deps.cliAgentSkip?.(model, startedAt, wasLate);
    if (blocked) {
      this.deps.store.patchState(job.id, {
        ...CLEAR_PENDING,
        next_due_at: nextDue(job.schedule, new Date(startedAt)).getTime(),
      });
      await this.deps.store.appendRun(job.id, blocked);
      return;
    }

    const status = host.status();
    const gpu = this.deps.gpuGate;
    const admissionReason = await gpuGateReason(
      {
        jobsRoot: this.deps.store.root,
        model: gpu?.model(model),
        gpuGate: gpu?.config(),
        loadedModels: gpu?.loadedModels ?? ((): readonly ModelConfig[] => []),
        now: this.deps.now,
        ...(gpu?.signal ? { signal: gpu.signal() } : {}),
        ...(gpu?.probe ? { probe: gpu.probe } : {}),
        ...(gpu?.wait ? { wait: gpu.wait } : {}),
      },
      async () => {
        // The same two cheap gates an agent task uses: nothing may compete with
        // a live turn, and the owner's own activity holds the job back.
        const busy = this.deps.busy();
        if (busy) return busy;
        const jobConversationIds = new Set(
          (await this.deps.store.loadAll()).flatMap((jf) =>
            [jf.state.conversation_id, jf.state.task_run?.conversation_id].filter(
              (id): id is string => typeof id === 'string' && id.length > 0,
            ),
          ),
        );
        const recent = status.conversations.filter((c) => startedAt - c.updatedAt < USER_QUIET_MS);
        return recent.length ? userQuietGate(recent, jobConversationIds, startedAt) : undefined;
      },
    );
    if (admissionReason !== undefined) {
      await deferBusyTask(this.deps.store, jobFile, startedAt, wasLate, admissionReason);
      return;
    }
    this.deps.store.patchState(job.id, CLEAR_PENDING);

    // A deleted job stops here: its files are gone, so nothing is left to write.
    if (!(await this.deps.store.load(job.id))) return;

    const reassessIds = new Set(action.reassess_ids);
    let records: RetitleConversation[];
    try {
      records = readRetitleRecords(dirs, { reassessIds });
    } catch (err) {
      await this.finish(jobFile, action, wasLate, startedAt, {
        ok: false,
        scanned: 0,
        offered: 0,
        applied: 0,
        refused: 0,
        sentence: `could not read this workspace's chats: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const streaming = new Set(status.streamingConversationIds);
    const jobConversationIds = new Set(
      (await this.deps.store.loadAll()).flatMap((jf) =>
        [jf.state.conversation_id, jf.state.task_run?.conversation_id].filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      ),
    );
    const candidates = pickRetitleCandidates(
      records.map((record) => ({
        ...record,
        ...(streaming.has(record.id) ? { streaming: true } : {}),
      })),
      {
        now: startedAt,
        minIdleMs: (action.min_idle_minutes ?? 60) * 60_000,
        limit: action.max_chats,
        jobConversationIds,
        reassessIds,
      },
    );

    if (action.dry_run) {
      await this.finish(jobFile, action, wasLate, startedAt, {
        ok: true,
        scanned: records.length,
        offered: candidates.length,
        applied: 0,
        refused: 0,
        sentence: `dry run: ${candidates.length} of ${records.length} chats would be retitled (${candidates
          .slice(0, 5)
          .map((c) => `"${c.title}"`)
          .join(', ')})`,
      });
      return;
    }

    let applied = 0;
    let refused = 0;
    const errors: string[] = [];
    let stopped: string | undefined;
    // Every name this workspace's chats already carry, so one pass cannot hand
    // two chats the same title — two of the first 150 applied titles were
    // identical, which makes the history list impossible to search by name.
    const takenTitles = new Set(
      records.map((record) => normalizeTitleKey(record.title)).filter((key) => key.length > 0),
    );
    for (const candidate of candidates) {
      // Stop the pass early, before asking rather than after: an ask that lands
      // while the owner is mid-turn competes with that turn for the GPU (the
      // admission gate's whole point), and an ask for a job that has been
      // deleted buys nothing. Both were checked once at admission only, so a
      // batch of twelve kept going through a gate that had since turned red.
      const busy = this.deps.busy();
      if (busy) {
        // Nothing named yet means the pass was pushed out before it started, not
        // partway through: a sibling job's turn admitted in the same tick took the
        // slot (2026-11-06: the 07:00 Maya update job and this 06:00 pass were both
        // due while the box was asleep, caught up in one tick, and its agent turn
        // was streaming by the first candidate — the run recorded ok, advanced
        // `next_due_at` a whole day, and toasted "gave 0 of 20 chats a new title").
        // A pass that named nothing is the same case as a busy admission, so hand it
        // to the pending path: `JobScheduler.runTick` re-runs a pending `retitle`
        // whatever the due time says, so it retries once the turn is over, and
        // `deferBusyTask`'s TTL drops it with a `skipped` row if the box stays busy
        // until the next scheduled pass. A pass that already named chats reports
        // what it did: the rest are still oldest-first tomorrow, so nothing is lost.
        if (applied === 0) {
          await deferBusyTask(this.deps.store, jobFile, startedAt, wasLate, busy);
          return;
        }
        stopped = `a turn started (${busy})`;
        break;
      }
      if (!(await this.deps.store.load(job.id))) {
        stopped = 'the job was deleted';
        break;
      }
      // Re-check against the live sidebar before each write: a chat the owner
      // opened or renamed since the scan is not this job's to name.
      if (host.status().streamingConversationIds.includes(candidate.id)) {
        refused++;
        continue;
      }
      let proposed: string | undefined;
      try {
        proposed = await this.proposeTitle(candidate, takenTitles);
      } catch (err) {
        // One dead model must not take the rest of the batch with it, and must
        // not leave this run unreported: the throw went out of `run()` into a
        // `void ... .finally()` in the scheduler, so the job got no run row,
        // no failure count and no backoff.
        errors.push(err instanceof Error ? err.message : String(err));
        refused++;
        continue;
      }
      if (!proposed) {
        refused++;
        continue;
      }
      if (host.applyAutoTitle!(candidate.id, proposed)) {
        applied++;
        // A name handed out in this pass is now taken: two chats renamed in one
        // batch must not land on the same name, and the set this started with is
        // a snapshot of what was on disk before the first rename.
        takenTitles.add(normalizeTitleKey(proposed));
      } else {
        refused++;
      }
    }

    const ok = errors.length === 0;
    const tail = stopped ? `, stopped early: ${stopped}` : '';
    await this.finish(jobFile, action, wasLate, startedAt, {
      ok,
      scanned: records.length,
      offered: candidates.length,
      applied,
      refused,
      sentence: ok
        ? `gave ${applied} of ${candidates.length} chats a new title (${records.length} chats scanned, ${refused} skipped${tail})`
        : `applied ${applied} titles; ${errors.length} model request(s) failed: ${errors[0]}${tail}`,
      ...(errors.length ? { error: errors.join('; ') } : {}),
    });
  }

  /** One title from the model, or undefined when the answer is not usable.
   *
   *  A name another chat already carries is asked for once more before it is
   *  refused: that is the failure the owner sees most, and one extra call on the
   *  rare hit is cheaper than a history list nobody can search. A name equal to
   *  the chat's own is not a new title at all — it is the model saying it would
   *  not change it, and a re-ask that reports a rename which renamed nothing is
   *  how a pass looks like it worked while doing nothing.
   */
  private async proposeTitle(
    candidate: RetitleCandidate,
    taken: ReadonlySet<string>,
  ): Promise<string | undefined> {
    const own = normalizeTitleKey(candidate.title);
    let avoid: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let answer: string;
      try {
        answer = await this.deps.summarize(buildRetitleRequest(candidate, avoid));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        getLogger().warn(`[Retitle] request failed for ${candidate.id}: ${detail}`);
        throw err;
      }
      const title = parseProposedTitle(answer, TITLE_MAX_UNITS);
      if (!title) return undefined;
      const key = normalizeTitleKey(title);
      if (key === own) {
        getLogger().info(`[Retitle] left ${candidate.id} alone: the model would not change it`);
        return undefined;
      }
      if (!taken.has(key)) return title;
      if (attempt === 0) {
        avoid = title;
        continue;
      }
      getLogger().info(
        `[Retitle] refused "${title}" for ${candidate.id}: another chat is already called that`,
      );
      return undefined;
    }
    return undefined;
  }

  private async finish(
    jobFile: JobFile,
    action: RetitleAction,
    wasLate: boolean,
    startedAt: number,
    outcome: RetitleRunOutcome & { error?: string },
  ): Promise<void> {
    const { job } = jobFile;
    if (!(await this.deps.store.load(job.id))) return;
    const now = this.deps.now();
    // A stale window is the cause the owner can act on: the job failed under
    // last night's config rules, not necessarily the ones this build uses.
    const stale = !outcome.ok ? this.deps.staleWindow?.() : undefined;
    const sentence = stale ? `${stale} ${outcome.sentence}` : outcome.sentence;
    let delivered = 0;
    // A run that named nothing is not worth a message unless the job asked for
    // every run to be reported; a failure always is.
    const shouldReport =
      !outcome.ok || outcome.applied > 0 || action.report === 'always' || action.dry_run;
    if (shouldReport) {
      delivered = await this.delivery.tryDeliver(job, `Retitle: ${sentence}`);
    }
    // Re-read before writing state: the job may have been deleted while this
    // run was asking for titles.
    const fresh = (await this.deps.store.load(job.id)) ?? jobFile;
    const consecutive = outcome.ok ? 0 : fresh.state.consecutive_failures + 1;
    const nextDueAt = outcome.ok
      ? nextDue(job.schedule, new Date(now)).getTime()
      : nextDueWithBackoff(job.schedule, new Date(now), consecutive);
    this.deps.store.patchState(job.id, {
      ...CLEAR_PENDING,
      last_run_at: now,
      ...(outcome.ok ? { last_ok_at: now, last_observation: jobFile.state.last_observation } : {}),
      next_due_at: nextDueAt,
      consecutive_failures: consecutive,
    });
    const row: RunRow = {
      at: startedAt,
      late: wasLate,
      outcome: outcome.ok ? 'ok' : 'failed',
      changed: outcome.applied > 0 || outcome.offered > 0,
      summary: sentence,
      ...(outcome.error ? { error: outcome.error } : {}),
      delivered,
    };
    await this.deps.store.appendRun(job.id, row);
  }
}
