# Job GPU gate plan

Status: **implemented 2026-10-01** (`38eea37`, merged `85b3f34`, 0.16.71); live check pending. Implementer: Copilot CLI. Reviewer: Claude.

## Problem

The jobs scheduler cannot see GPU work that Forge did not start. On
2026-10-01 a Nemotron training run (python, started 02:58) held 14.3–14.5 GB
on each RTX 5060 Ti. The Forge window had been running the scheduler since
22:15 the night before. At 08:00 `llama-updates` fired an `agent_task` on
`qwen38-27b-mtp-ud-q6k-tensor-vision`, a 27B Q6 split across those same two
GPUs. It failed only because the chat cap refused it ("all 12 open chats are
busy") before any model loaded. Four more local-model jobs were due between
08:10 and 09:00. The user paused every job by hand at 08:02.

If any of them had loaded, the result would have been an out-of-memory error,
or a WDDM spill into system RAM that slows the training to a crawl.

`canStartNow` (`src/jobs/agentTaskAdmission.ts`) only knows about Forge's own
pool and streaming chats. Training jobs, Strata, ComfyUI and anything else on
the GPU are invisible to it.

### Why a single utilization reading is not enough

Measured at 08:0x on 2026-10-01 while training was running (GPU 0 / 1 / 2, %):

```
10 / 30 / 31
16 /  0 / 37
 4 / 51 / 18
 0 /  0 / 11   <- looks idle, training is mid-run
```

Training drops to 0% between steps. A loaded but idle process (a paused
training run, or Strata waiting for a request) sits at 0% while holding
14 GB. Two signals are needed: utilization sampled over a window, and VRAM.

On Windows (WDDM), `nvidia-smi --query-compute-apps` reports `[N/A]` for
per-process memory (see the header of `src/system/systemProbes.ts`), so VRAM
cannot be attributed to a process. Only per-GPU totals are usable.

## Design

Two independent gates, both checked at agent-task admission, next to
`canStartNow` and `userQuietGate` in `src/jobs/agentTask.ts`. A failing gate
**defers** the task through the existing `deferBusyTask` path. It never fails
the run. The existing `task_pending` TTL (one schedule period) still applies,
and the TTL skip row names the GPU reason.

### Which jobs are gated

Only `agent_task` actions whose model runs on this machine's GPUs:

- add `usesLocalGpu(model)` to `src/backend/ModelHeuristics.ts`, next to
  `isLocalModel`. It returns true for `isLocalModel(model)` **or** a
  `provider: openai-compatible` model whose `endpoint` host is loopback
  (`127.0.0.1`, `localhost`, `::1`). Strata (`strata-flashnext-iq3s`) is the
  case that needs the second branch.
- **Do not change `isLocalModel`.** Other callers depend on its current
  meaning.

Cloud models, CLI agents (`provider: cli`), watch-only jobs and
`llamacpp_update` actions are not gated.

### Gate 1 — the hold file (explicit, exact)

`~/.forge/jobs/gpu.hold`, in the JobStore root. The name deliberately does not
end in `.json`, so `JobStore`'s definition filter (`name.endsWith('.json')`,
`JobStore.ts:25`) never reads it as a job.

- While the file exists, every gated job defers with the reason
  `GPU hold (<reason>, since <mtime>)`.
- The content is optional. An empty file means hold indefinitely. Otherwise it
  is JSON: `{ "reason"?: string, "pid"?: number, "until"?: ISO-8601 string }`,
  validated with Zod.
- **`pid` set and that process no longer exists:** the hold is stale and
  ignored. The run row and `manage_jobs list` say `stale GPU hold from pid N
  ignored`. Forge does not delete the file, because Forge did not create it.
- **`until` in the past:** ignored the same way, with `expired GPU hold
  ignored`.
- **File present but unparseable:** treated as a hold (fail closed), with the
  reason `unreadable GPU hold file: <zod error>`.
- Honoured whether or not `jobs.gpu_gate` is configured. It is an explicit
  user signal that costs one `stat` per gated admission.

Usage, for a training script or another agent:

```powershell
'{"reason":"nemotron training","pid":' + $PID + '}' | Set-Content "$HOME\.forge\jobs\gpu.hold"
# ... train ...
Remove-Item "$HOME\.forge\jobs\gpu.hold"
```

### Gate 2 — the sampled GPU probe (the safety net)

Configured under `jobs:` in `config.yaml`. If the block is absent, there is no
probe and today's behaviour is unchanged.

```yaml
jobs:
  gpu_gate:
    gpus: [0, 1]            # nvidia-smi indices (NOT CUDA/llama.cpp order) of the GPUs local models use
    max_util_percent: 1     # every sample on every listed GPU must be <= this
    max_idle_vram_mb: 1024  # per listed GPU, only checked when Forge has no local model loaded
    sample_seconds: 15      # samples are 1 s apart
```

Schema in `src/config/jobsSchema.ts`: `gpus` is required and non-empty. The
other three fields carry schema defaults, the same way `max_concurrent` does.

Rules:

1. **Utilization.** Call `probeGpus()` from `systemProbes.ts` once a second
   for `sample_seconds`. If **any** sample on **any** listed GPU exceeds
   `max_util_percent`, defer and stop sampling at once. The reason names the
   GPU and the value: `GPU 0 at 41% (limit 1%)`.
2. **VRAM, only when Forge has no local model loaded.** If the pool reports no
   loaded local model, all VRAM in use belongs to something else. If any
   listed GPU's `memoryUsedMb` exceeds `max_idle_vram_mb`, defer with
   `GPU 0 has 14507 MiB in use by another process (limit 1024)`. When Forge
   has a model loaded, VRAM cannot be split between Forge and others on WDDM,
   so only rule 1 applies (see Known limitations).
3. **Probe failure fails closed.** If `nvidia-smi` is missing, exits non-zero
   or returns no row for a listed index, defer with the probe's own error text
   (`describeProbeFailure`). A configured gate that cannot see the GPU must
   not wave jobs through. Listing an index that does not exist is a config
   error the user should see, not a silent pass.
4. **Cancellation.** Sampling takes an `AbortSignal`. Scheduler disposal (or
   loss of the lease) aborts it, and an aborted sample is a deferral, not a
   failure.
5. **Order of checks.** Hold file, then the cheap existing gates
   (`canStartNow`, `userQuietGate`), then the probe. The 15 s probe only runs
   when everything else would have let the job start.

### Recording the reason

Add `task_pending_reason: string | null` (default `null`) to `JobStateSchema`
in `src/jobs/jobSchema.ts`, and to `CLEAR_PENDING` and the JobStore initial
state. `deferBusyTask` takes the reason. Every existing caller passes one too:
`canStartNow`'s `reason`, or the `userQuietGate` string. The fields are:

- the TTL skip summary becomes `skipped: busy (pending N min; <last reason>)`;
- `manage_jobs list` and `inspect` show `pending: <reason>` for a pending job
  (`src/tools/jobTools.ts`, beside the `enabled`/`paused` status);
- `run_now` gets no bypass. A run request still goes through admission, and
  the pending reason is visible in `list`.

### Files

| File | Change |
|---|---|
| `src/jobs/gpuIdleGate.ts` (new) | Hold-file read and validation, the sampled probe, and one exported `gpuGateReason(...)` returning `string \| undefined` |
| `src/backend/ModelHeuristics.ts` | `usesLocalGpu(model)` |
| `src/config/jobsSchema.ts`, `src/config/types.ts` | `gpu_gate` block |
| `src/vscode/jobsSetup.ts` | Pass `gpuGate` config through, where `maxConcurrent` is passed |
| `src/jobs/agentTask.ts` | Call the gate (target: under ~15 added lines; logic stays in the new module) |
| `src/jobs/agentTaskAdmission.ts` | `deferBusyTask` takes and stores the reason |
| `src/jobs/jobSchema.ts`, `src/jobs/JobStore.ts` | `task_pending_reason` |
| `src/tools/jobTools.ts` | Show the pending reason |
| `config/config.example.yaml` | Commented `gpu_gate` example under `jobs:` |
| `docs/JOBS.md` | Section "Keeping jobs off a busy GPU": hold file and `gpu_gate` |
| `docs/OWNERS.md` | Row for `gpuIdleGate.ts` |
| `CHANGES.md` | Entry under the unreleased version |
| Tests | `test/unit/GpuIdleGate.test.ts` (new), plus existing agent-task/admission tests extended |

Do **not** edit `.forge/config.yaml`. It is hot-reloaded under a running turn.
Claude enables `gpu_gate` there after review.

## Execution rules for this run (read before editing)

These are enforced gates. The last run of this kind missed two of them.

- **500 physical lines per `.ts` file is a hard stop.** ESLint `max-lines`
  fails `npm run ci` above it. Line counts now: `agentTask.ts` 322,
  `JobScheduler.ts` 416, `agentTaskAdmission.ts` 123, **`jobTools.ts` 465**,
  which has room for the one-line pending-reason display and nothing more.
  New logic goes in `gpuIdleGate.ts`, not in the scheduler. Measure with
  `npx eslint <file>` or `wc -l`.
- **Run `npm run ci` after the last edit, and report its exact result.** Run
  it with Git's bash first on PATH, or WSL can hang the run (FORGE.md, "Workspace facts"):
  `$env:PATH = "C:\Program Files\Git\bin;$env:PATH"; npm run ci`.
- **Prettier errors:** `npx eslint --fix <file>`, then re-run.
- **Exported functions need a caller** in the same change. No dead helpers.
- **Grep before adding.** `probeGpus`, `describeProbeFailure`,
  `deferBusyTask` and `isLocalModel` already exist. Extend them; don't copy
  them.
- **Do not commit.** Leave the tree for review.
- **Do not touch `.forge/config.yaml`.**
- Tests must stub `probeGpus` and the clock. No test may call the real
  `nvidia-smi` or sleep in real time.

## Known limitations

- **Forge has a model loaded and a foreign process also holds VRAM but is
  idle** (for example a paused training run): rule 2 is skipped and rule 1
  sees 0%, so the job can start. The hold file covers this case. The VRAM
  check cannot, on WDDM.
- **Something starts on the GPU after admission:** the gate decides once, at
  admission. A running job is not paused.
- **The probe holds one scheduler worker for up to `sample_seconds`.** With
  `max_concurrent: 2`, the other worker keeps running.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `jobs.gpu_gate` in config.yaml | Hand edit (Claude after review, or the user) | Hand edit; absent means no probe, today's behaviour | Remove the block. The hold file still works without it | Config loader rejects invalid YAML/Zod and keeps the last good config, surfacing the error (existing ConfigLoader behaviour) | Nothing in memory to lose; the next `getConfig()` reads the file | None; lasts until removed |
| `~/.forge/jobs/gpu.hold` | The user, a training script or another agent; never Forge | The creator removes it; Forge never deletes it | Deleting it releases the hold; an `until` in the past also releases it | A truncated or partial file fails Zod and is treated as a hold (fail closed), with the error in the reason | `pid` set and dead: stale hold, ignored and reported. No `pid`: holds until removed, and every deferral reason shows its age | `until` field; none means indefinite, visible via `manage_jobs list` |
| `state/<id>.json` `task_pending_reason` | `deferBusyTask` on every deferral | Cleared with `CLEAR_PENDING` on start, on TTL skip, and on job delete (the state file goes with the job) | A paused job is never admitted, so it is never written; resume starts clean on the next due tick | JobStore's existing atomic state write; an old state file without the field parses to `null` via the schema default | Next window's scheduler re-reads it; the stale reason is overwritten by the next admission | Bounded by the existing `task_pending` TTL of one schedule period |
| Run rows in `runs/<id>.jsonl` for GPU deferrals | Only the TTL skip writes a row; a plain deferral writes none (no log spam every 30 s tick) | Existing run-log retention (unchanged) | n/a: a paused job writes no rows | Existing append semantics (unchanged) | Existing (unchanged) | Existing retention (unchanged) |

CI-enforced row: `test/unit/GpuIdleGate.test.ts` asserts that an unparseable
`gpu.hold` defers (fail closed). It also asserts that a `gpu.hold` beside job
definitions is never returned by `JobStore.loadAll()`.

## Acceptance criteria

- [x] With `gpu.hold` present (empty), a due local-model `agent_task` defers.
  `task_pending_reason` names the hold, and no conversation is created.
  — `GpuIdleGate.test.ts`, agent-task test
- [x] `gpu.hold` with a dead `pid`, or an `until` in the past, does not block,
  and is logged as stale or expired (Forge log only — see Deviations). — `GpuIdleGate.test.ts`
- [x] An unparseable `gpu.hold` blocks (fail closed). — `GpuIdleGate.test.ts`
- [x] `JobStore.loadAll()` never returns `gpu.hold` as a job.
  — `GpuIdleGate.test.ts`
- [x] With `gpu_gate` configured: samples `[0,0,0,0,41]` on GPU 0 defer, and
  sampling stops at the first sample over the limit (the stub sees five
  calls, not fifteen). All-zero samples admit. — `GpuIdleGate.test.ts`
- [x] With no Forge local model loaded, a listed GPU over `max_idle_vram_mb`
  defers. With a Forge local model loaded, the same VRAM does not defer.
  — `GpuIdleGate.test.ts`
- [x] `nvidia-smi` missing or failing, or a listed index absent from the
  probe output, defers with the probe's error text. — `GpuIdleGate.test.ts`
- [x] Cloud, CLI-agent and watch-only jobs are never gated, even with
  `gpu.hold` present. A `openai-compatible` loopback model (Strata) is gated.
  — `GpuIdleGate.test.ts`, `ModelHeuristics` test
- [x] Without a `gpu_gate` block, the probe is never called (existing tests
  unchanged and green).
- [x] A pending task past one schedule period writes one
  `skipped: busy (pending N min; <reason>)` row, then waits for the next due
  time. — admission test
- [x] `manage_jobs list` shows `pending: <reason>` for a pending job.
  — jobTools test
- [x] Aborting the scheduler mid-sample defers and does not fail the run.
  — `GpuIdleGate.test.ts`
- [x] Every new or touched `.ts` file is under 500 lines, and `npm run ci` is
  green after the last edit.
- [x] `docs/JOBS.md`, `config/config.example.yaml`, `docs/OWNERS.md` and
  `CHANGES.md` updated.
- [ ] Live check (Claude, after review): with training running on GPUs 0/1
  and `gpu_gate.gpus: [0, 1]`, `run_now` on `hf-qwopus-thread` stays pending
  with a GPU reason. After training stops, it runs.

## Outcome (2026-10-01)

Implemented by Copilot CLI in a separate worktree, reviewed by Claude. `npm run ci` green
(3664 passed, 39 skipped). Live check still pending.

Deviations from the plan:

- A stale (dead `pid`) or expired hold is reported in the Forge log only, not in
  a run row or `manage_jobs list`. The hold does not block, so the task starts
  and there is no pending state to carry the note.
- The TTL skip row names the reason from the deferral that hit the TTL, which is
  the current blocker, not the reason first stored.
- Admission order (hold, cheap gates, probe) is kept by passing the cheap gates
  to `gpuGateReason` as a callback.
