# Weekly implementation audit — 2026-09-21

## Result

**11 findings: 3 high priority (P1), 7 medium priority (P2), 1 cleanup/documentation finding (P3).** Ten concern implementations introduced in the audited range; one release-workflow issue is pre-existing. No product fixes were made during this audit.

The strongest problems are a thinking-control regression, scheduler failover that never starts, and acknowledged contact requests that cannot resume after a reload. Six isolated characterization probes reproduce defects; a seventh rejects a suspected mesh FIFO race after modeling production's serialized event writes. Passing characterization probes means the described behavior exists, not that the behavior is correct.

This is a risk-focused commit audit, not a claim that every execution path is defect-free. The size of this week's change makes that distinction material: **97 commits, 356 changed files, 40,748 insertions, 1,881 deletions**.

## Remediation status (2026-09-21)

All eleven findings were fixed the same day. Each behavioural fix has a regression test that asserts the intended behaviour.

| Finding | Fix | Regression test |
| --- | --- | --- |
| A1 | An explicit `enable_thinking` in the request (a truncation-recovery round) wins over the model's `think` default | `RequestNormalizer.test.ts`, `ToolCallTruncation.test.ts` |
| A2 | A window that lost the first lease acquisition keeps its tick running and takes over when the owner leaves; every enabled window watches the store | `JobSchedulerOwnership.test.ts` |
| A3 | Contact messages are stored with a durable disposition before the acknowledgement; `recoverInterrupted()` re-runs unfinished rows after transport start; trimming keeps unfinished rows | `TelegramContactRecovery.test.ts` |
| A4 | The store watch ignores non-definition files (lease heartbeats); `WakeReconciler` re-registers only when the schedule changes | `JobSchedulerOwnership.test.ts` |
| A5 | Mesh locks are published whole (temp file + hard link); an unreadable lock older than 2 s is reclaimed through a rename-aside that restores a lock taken in between; waiting sleeps instead of spinning | `AgentMeshLock.test.ts` (includes 3-process contention) |
| A6 | `inboundKey` (`channel:chat:providerMessageId`) is admitted atomically; duplicates are ignored within one process and after a reload | `TelegramContactRecovery.test.ts` |
| A7 | A jobs-disabled window deletes the wake task only while holding the scheduler lease (`clearWakesIfUnowned`) | `JobSchedulerOwnership.test.ts` |
| A8 | Paused jobs are skipped by `processPendingSummaries` | `JobSchedulerOwnership.test.ts` |
| A9 | Durable `summary_failures` / `summary_retry_at` backoff (1 min doubling, 6 h cap); only the first failure is reported, and success says "recovered" | `JobSchedulerOwnership.test.ts` |
| A10 | Dead `hostWait.ts` removed; the plan and handoff now say no empty-turn cost guard is enforced. The other unused exports listed are left as cleanup candidates | — |
| A11 | `publish.yml` checks tag = version, runs `npm run package`, and publishes that one VSIX to every registry | `PublishWorkflowContract.test.ts` |

## Scope and method

- Window: September 14–21, 2026, through the HEAD observed when the audit began. All of September 14 is included to avoid cutting the first implementation day in half.
- Baseline, excluded: `5f377b43cfbc46fa90ca7981ff8df83f8c3a8943` (September 13).
- Audited tip, included: `1f282423239418763c865c3e6d6c58246f45b058`.
- Exact range: `5f377b43..1f282423`. The complete chronological inventory is below; no date-filter-only selection was used.
- Version at the audited tip: `0.16.19`.
- Initial working tree was clean. During the pause, HEAD advanced to `5299117cf01017a69769b25d4e627b34e82908b0` through two plan-only commits (`3ed1987`, `5299117`). `git diff --name-only 1f282423 HEAD` showed only `docs/plans/AGENT_TASK_JOBS_PLAN.md`. Product code used by the probes therefore still matches the audited tip.
- An unrelated untracked `project_llamacpp_install_location.md` appeared during the pause. It was left alone.

The repository's five-step investigation limit was applied as five bounded passes after establishing the range: (1) change inventory and jobs/lifecycle review, (2) mesh and contact delivery review, (3) model/image/compaction and unused-symbol cross-checks, (4) isolated reproduction and commit attribution, (5) report and repository quality gates. No live agent, paid model, Telegram message, machine sleep, scheduled-task mutation, installation, commit, or push was performed.

Review depth:

| Area | Work performed |
| --- | --- |
| Persistent jobs and power | Traced startup, lease/watch lifecycle, scheduling, pending summaries, update-action wiring, and wake-task ownership. |
| Agent mesh | Traced admission/FIFO/event-log ordering, locks, owned-session resolution, and unused helper modules. |
| Telegram contacts | Traced group admission, persistence, burst timers, restart, duplicate delivery, and isolated prompt dispatch. |
| Model turn and compaction | Read loop/recovery changes and request normalization; verified the thinking override regression. |
| Images, search, checkpoints | Reviewed selected changed owners for path/write/budget handling; no additional confirmed findings asserted here. |
| Release and documentation | Checked scripts/workflows, plan claims, and production references for new exported helpers. |
| Remaining UI/config/benchmark changes | Change-inventory triage and repository gates; not every UI state, provider, or benchmark was exercised live. |

## Findings

### A1 — P1: normalization undoes thinking suppression during recovery

**Introduced:** `21fca93cf17da34ccce44f11d93c6d7ab9d72e24` (Nemotron model support). **Status:** open; reproduced by probe F7.

**Evidence:** `src/llm/RequestNormalizer.ts:22–24`; recovery request construction in `src/agent/ToolCallingLoop.ts:199–200,253–276`.

When `chat_template_thinking: true` and `think: true`, normalization spreads the request kwargs and then assigns `enable_thinking: model.think !== false`. A recovery request explicitly carrying `enable_thinking: false` becomes `true` again. The probe supplies exactly that combination and observes `true` in the normalized output.

**Trigger/impact:** a thinking-enabled model using this flag truncates a tool call or stops inside reasoning. The recovery loop budgets and builds a retry assuming thinking is disabled, but the outgoing request re-enables it. Reasoning can consume the room intended for the recovered call and repeat the truncation. This breaks the documented truncation-recovery invariant; it does not affect every model or every normal turn.

**Fix direction:** treat model configuration as the default only when the request has not supplied `enable_thinking`. Add a request-normalizer regression test and an end-to-end loop request assertion for the model flag plus a recovery round.

### A2 — P1: the window that loses initial scheduler acquisition never takes over

**Introduced:** `a0d7b824112f1d2587cd336ebefac1ea7e793267`. Later recovery work in `a4622b2c6019ad6085a481e93445c5411e143057` does not cover this path. **Status:** open; reproduced by probe F2.

**Evidence:** `src/jobs/JobScheduler.ts:133–147,232–239`; `src/vscode/jobsSetup.ts:111–127`.

`start()` returns `false` on the first unsuccessful lease acquisition, before installing its tick interval. Production leaves `started = true`; only an owner installs the watcher. The recovery logic in `tick()` is unreachable for this passive window because nothing calls it.

**Trigger/impact:** open enabled windows A and B; A holds the scheduler lease, B loses acquisition. Close A while keeping B open. B never retries, so jobs stop running even after the lease is free. A config reload that leaves jobs enabled also sees `started = true` and does not restart B. Reopening/toggling the subsystem can recover it, but ordinary ownership transfer cannot.

**Fix direction:** keep a bounded passive acquisition timer alive for enabled non-owners and install/reconcile the watcher when ownership is acquired. Test two windows, owner shutdown, and eventual takeover without manual `tick()` calls.

### A3 — P1: contact messages are acknowledged before pending work is recoverable

**Introduced:** `71fc85b9082b311452b5c0aa19be6c4b496cb181`; carried into the group implementation by `3647b54237b459c6fe530d6f800b56c22565d698`. **Status:** open; reproduced by probe F6.

**Evidence:** `src/remote/TelegramContactService.ts:50,141–144,258–279,282–295`; `src/remote/TelegramPolling.ts:125–127`.

Admission writes a history row, stores the pending batch only in `bursts`, starts a timer, and returns `handled`. Polling can then persist the Telegram cursor. Disposal clears the timer/map. Reconstruction has no pending-contact-work scan; thread history contains text but no execution state to recover.

**Trigger/impact:** accept a contact message, then reload or crash during the default five-second burst window, or while queued behind another generation. The phone has seen the thinking acknowledgement, the update has been consumed, but no answer or terminal failure is recovered. The probe reloads the persisted store and confirms that the history survives while no model request is reconstructed.

**Fix direction:** persist contact request identity and a pending/running/terminal disposition before acknowledging it. On restart, explicitly recover or report interrupted work. Preserve the burst grouping as durable request state, and test reload before the timer, reload during generation, and send-result uncertainty.

### A4 — P2: heartbeat temporary files bypass the watcher filter and recreate wake tasks

**Introduced:** scheduler/watch combination in `a0d7b824112f1d2587cd336ebefac1ea7e793267`; incomplete filter/atomic-heartbeat remediation in `3647b54237b459c6fe530d6f800b56c22565d698`. **Status:** open; reproduced by probe F3 with real temporary-directory filesystem events.

**Evidence:** `src/jobs/JobStore.ts:373–383`; `src/util/FileLease.ts:56,145–170`; `src/jobs/JobScheduler.ts:208–222`; `src/system/PowerControl.ts:299–319`.

The filter ignores filenames ending in `.lease.json`. Heartbeats now create `<lease>.lease.json.<token>.heartbeat-<time>.tmp`, which does not match that filter. Creation/removal of these temporary files triggers the one-second watch callback without any job edit. The callback reconciles wakes, and every nonempty reconciliation invokes the wake-policy probe and scheduled-task registration without comparing the schedule to the existing one.

**Trigger/impact:** enable the scheduler and at least one waking job. The normal five-second heartbeat can cause continual PowerShell/task-registration work while the machine is otherwise idle. The reproduction accelerates the heartbeat to 100 ms and proves a watcher callback occurs solely from heartbeat activity; it does not modify the real Windows scheduled task.

**Fix direction:** watch only job definition filenames, or move lease artifacts outside the watched directory; also deduplicate wake reconciliation by the computed schedule and handle callback rejection. Test the actual temporary heartbeat filename, not only the final lease filename.

### A5 — P2: an empty/corrupt mesh lock permanently blocks future operations

**Introduced in-range:** present in the shared lock extracted by `afaa1ce32e4d9cd976ab74e4a63f15c63d07a31d`. **Status:** open; reproduced by probe F4.

**Evidence:** `src/agentMesh/lock.ts:49–60,65–88`; consumers in `src/agentMesh/aliasRegistry.ts` and `src/agentMesh/exchangeLog.ts`.

The exclusive file is created before its owner record is written. A crash between those operations leaves an empty lock. Parse failure sets `rec = undefined` with a comment saying “treat as stale,” but both reclaim branches require a defined `holderId`. It therefore spins until the deadline and leaves the same file behind. Every future acquisition repeats the failure.

**Trigger/impact:** interrupted lock initialization or corrupt lock contents prevents alias/event-log operations indefinitely until the artifact is repaired externally. The probe creates an empty lock, reports every host dead, and still receives `held by live host pid ?`; the file remains empty. Waiting is a synchronous busy loop, so the normal five-second timeout also stalls the extension host.

**Fix direction:** design recovery for incomplete lock initialization without immediately deleting a live creator's not-yet-written file; use an atomic owner-publication protocol or a bounded verified orphan-recovery mechanism. Test crash-after-create, partial JSON, concurrent creator/recoverer, and actual process contention.

### A6 — P2: duplicate Telegram contact updates are admitted as new work

**Introduced:** `71fc85b9082b311452b5c0aa19be6c4b496cb181`; retained by `3647b54237b459c6fe530d6f800b56c22565d698`. **Status:** open; reproduced by the redelivery assertion in probe F6.

**Evidence:** `src/remote/TelegramContactService.ts:258–267`; early group/contact routing in `src/remote/RemoteController.ts:239–245`.

Every admission assigns `randomUUID()` and saves the text; it does not retain/check `providerMessageId` as a deduplication key. This route does not use ordinary prompt admission's durable request deduplication.

**Trigger/impact:** a provider redelivers after an acknowledgement/cursor failure or a restart before the cursor commit. The same message ID is saved twice and can be answered twice or consume multiple positions in the burst throttle. The probe delivers the identical event after reopening the persisted store and sees two thread entries.

**Fix direction:** persist an inbound key based on channel/chat/provider-message identity and atomically deduplicate before adding work. Test duplicates in the same process, across restart, and after sending an answer but before cursor persistence. This is separate from A3: recovery needs both durable work and duplicate protection.

### A7 — P2: a jobs-disabled window can delete another window's shared wake task

**Introduced:** `a0d7b824112f1d2587cd336ebefac1ea7e793267`. **Status:** open; confirmed by the production call path, not by changing the machine's real task.

**Evidence:** `src/vscode/jobsSetup.ts:129,136–139`; `src/system/PowerControl.ts:39,299–303,337–343`.

Activation with jobs disabled unconditionally calls `setScheduledWakes([])`. Disabling jobs on config reload does the same before testing scheduler ownership. Empty wakes delete the single machine task named `ForgeScheduledWake`. Neither branch acquires/verifies the shared scheduler lease.

**Trigger/impact:** workspace A has enabled wake jobs and holds the lease; workspace B uses a different config with jobs disabled. Opening B can remove A's wake task. A later reconciliation may recreate it, but the shared schedule is incorrect in the meantime. Once A4 is fixed, accidental heartbeat-based restoration also disappears.

**Fix direction:** make deletion obey the same machine-wide owner protocol as registration, including startup cleanup of stale tasks. Test an enabled owner plus a disabled non-owner, and disable/re-enable while another owner remains active.

### A8 — P2: pausing a job does not stop its deferred model summary

**Introduced in-range:** behavior exists in `a4622b2c6019ad6085a481e93445c5411e143057`'s extracted delivery implementation. **Status:** open; reproduced by probe F5.

**Evidence:** `src/jobs/JobDelivery.ts:92–100`; scheduler invocation at `src/jobs/JobScheduler.ts:295–299`.

`processPendingSummaries()` selects `summary_pending` jobs without checking `job.enabled`. A paused job can still call the model, deliver a notification, and clear the pending state on the next idle tick, even though normal scheduled execution skips disabled jobs.

**Trigger/impact:** a change is deferred while the model is busy; pause that job; let the backend become idle. It still spends model work and sends a summary without an explicit `run_now`. The probe saves `enabled: false, summary_pending: true` and observes the summarizer called once and the flag cleared.

**Fix direction:** define pause semantics consistently and skip deferred model work while paused unless there is a separate explicit run authorization. Test pause/resume with pending summaries and pending mutating actions.

### A9 — P2: failing deferred summaries retry every tick without backoff or a phone-visible failure

**Introduced in-range:** retained in `a4622b2c6019ad6085a481e93445c5411e143057`. **Status:** open; source-confirmed, no live model calls made.

**Evidence:** `src/jobs/JobDelivery.ts:92–104`; default tick interval in `src/jobs/JobScheduler.ts:61` and invocation after runs at `295–299`.

The deferred-summary catch emits only a local toast. It does not clear pending state, record a summary retry deadline, increment a failure counter, or write an outbox item. Every idle scheduler tick therefore attempts the same model work again, independent of the check's normal interval/backoff.

**Trigger/impact:** a pending summary repeatedly fails because its provider/model is unavailable or the request is rejected. With the default tick this can retry every 30 seconds, generating repeated local notifications and model/network attempts while a remote-only user receives no failure explanation.

**Fix direction:** track delivery/summary failures separately from check failures; bound retries with backoff and send one durable failure notification plus recovery notification. Do not lose the pending observation when handling failure.

### A10 — P3: the mesh host-wait/cost-guard module is dead code, while the plan describes it as shipped

**Introduced:** `d34427fdbebcf7931706a3895ebc26f2323f4d77`. **Status:** open; static reference check.

**Evidence:** all **103 physical lines** of `src/agentMesh/hostWait.ts`; M7 and cost-guard claims in `docs/plans/AGENT_MESH_PLAN.md:102–106,298–300`; implementation module inventory in `docs/plans/AGENT_MESH_IMPLEMENTATION_HANDOFF.md:235`.

`waitHostSide`, `waitForFile`, and `exceededCostGuard` have no callers outside their own module in `src`, `test`, or `scripts`. The live session tool instead uses `waitForReply`; owned sessions wait through the FIFO. Merely exporting `exceededCostGuard()` enforces no limit on empty model turns.

There are additional unused production exports: `projectBoardView`, `matchThread`, `isMeshCommand`, `currentHost`, `removeAlias`, `removeOwnership`, and `MeshAdapterFactory`. Some are used by unit tests only; these are cleanup candidates, not automatically runtime defects. In contrast, test-only reset helpers and `FakeRemoteChannel` were deliberately excluded from the dead-product-code finding.

**Impact/fix direction:** the dead module and plan text create false confidence about enforcement and add maintenance surface. Either connect the intended guard to a real owner and test its effect, or remove unused helpers and correct the plan's acceptance status. Do not describe existing alternative host waits as absent; the missing part is this advertised module/guard's integration.

### A11 — P2: the publish workflow bypasses the canonical packaging gate

**Pre-existing:** present at baseline; last pre-range edit of the workflow is `7006e50e485b4aa293391b4b439529b16d0c0b7f`. **Status:** open; source-confirmed.

**Evidence:** `.github/workflows/publish.yml` steps “Publish to VS Code Marketplace” and “Package the VSIX”; `package.json` scripts `package` and `publish`; `.github/workflows/ci.yml`.

CI runs `npm run ci` and `npm run package`, but tag publishing runs `npm run publish`, then manually runs changelog sync and `vsce package`. Those paths omit `scripts/check-vsix-version.mjs`, which is part of the canonical package script. Marketplace publication happens before the later standalone package operation.

**Trigger/impact:** a release tag can take a different validation path than the local/CI release package, including bypassing the version check. This is a release-integrity gap and an explicit repository workflow-rule mismatch, not evidence that a bad release has already shipped.

**Fix direction:** run the canonical package gate before publication and use the validated artifact consistently. Add a workflow contract check if the repository wants this invariant enforced automatically.

## Rejected or narrowed claims

- **Mesh FIFO send-before-acceptance:** an initial generic asynchronous callback fixture exposed a race, but it omitted production's serialized event-log writes. The corrected fixture, C1, serializes acceptance/completion/start writes like `appendEvent` and verifies that the failed message is not sent. It is not counted as a production bug.
- **Heartbeat filter already fixed:** only partly. The final lease filename is filtered, but its new heartbeat temporary filenames still trigger callbacks (A4).
- **Daily/weekly wake collision loses the weekly day:** not supported. `wakeTimesFor` unions weekdays and promotes a shared clock time to a daily trigger, which includes the weekly day.
- **Checkpoint eviction necessarily deletes a later Undo's snapshot:** not established by the cited fire-and-forget code alone. Different checkpoint references cannot be assumed to name the same storage. Not counted.
- **Every invalid session is silently discarded without any saved copy:** stale at the audited tip. `sessionPersistence.ts` now logs schema errors and writes `SESSION_KEY_V1_CORRUPT`. This does not prove full recovery UX, but the earlier absolute claim is no longer accurate.
- **A tool or feature exists in a future plan:** not treated as an implementation defect. The new agent-task job runner is explicitly future work, not shipped behavior to audit as though complete.

The older `docs/AUDIT_TOP10_RISKS_2026-09-21.md` was used as a list of leads, not as evidence. Its remaining claims are not certified by this report.

## Validation and limits

The exact isolated probes are archived in [WEEKLY_IMPLEMENTATION_AUDIT_2026-09-21_EVIDENCE.md](WEEKLY_IMPLEMENTATION_AUDIT_2026-09-21_EVIDENCE.md). Final probe result: **7 passed, 0 failed, exit 0** (six defect characterizations plus one rejected-candidate control). The initial generic FIFO probe and the failed production-style expectation were superseded by C1; their initial result is not used to substantiate a finding.

Final repository-wide command results, test counts, package result, and whitespace check are recorded in [WEEKLY_IMPLEMENTATION_AUDIT_2026-09-21_VALIDATION.txt](WEEKLY_IMPLEMENTATION_AUDIT_2026-09-21_VALIDATION.txt), generated after report/evidence edits. The temporary executable probe file is removed before those gates, so the repository-wide count is not inflated by audit characterizations. The source of the probes remains in the evidence document for reproduction.

No live Telegram/network provider, multi-window VS Code host, model truncation run, hardware wake/sleep cycle, or real release publication was exercised. The isolated tests cover code behavior with fakes or temporary local filesystem state; they do not establish end-to-end operational reliability. Linux/macOS activation and provider-specific image/web behavior remain unverified. Existing skipped live tests remain a live-system risk even if CI is green.

Suggested repair order: A1/A2/A3 first; A6 alongside A3; then A4/A7 together because they share wake lifecycle ownership; then A5/A8/A9; reconcile A10 and repair A11 before the next release. Each behavioral fix should add a regression test asserting the desired behavior, rather than preserving these characterization expectations.

## Complete commit inventory

The following list is generated directly from `git log --reverse --format="%H | %cI | %s" 5f377b43..1f282423`.

```text
4dcb8264bf81e4f152f486bcd3e9c9b5796f1bc9 | 2026-09-14T11:30:05+03:00 | feat(remote): keep streamed words out of the Telegram progress bubble
c606df058078e1af4bf9b1d99ab190b9d1e61360 | 2026-09-14T11:30:05+03:00 | feat(tools): generate_image through cloud image APIs, delivered to Telegram
aeedc457a23f7563035d6a1db2a28f0509f586d1 | 2026-09-14T11:30:05+03:00 | feat(sidebar): clickable thumbnail for generate_image results
0774257bcb752d30e885a2e4a947b16ef8bcfbb8 | 2026-09-14T11:30:06+03:00 | fix(agents): make Forge-spawned Claude sessions visible in the Claude extension history
f0f67a923d7366b001e7516b929f763784f9ae6c | 2026-09-14T11:35:20+03:00 | fix(search): no embedding chunk can overflow the physical batch
6277ff4a88244054d38525907f10b37bded94aba | 2026-09-14T11:35:20+03:00 | release 0.16.0: consolidate the unreleased 0.15.35-0.15.52 line
ea1fd5258a138dfaf3cd766a9bb2808667abd499 | 2026-09-14T11:48:57+03:00 | fix(tools): match a Windows-path program name on every host
b9a19c53b9722c2b5fc88bd4aea6ec5d7ca8add2 | 2026-09-14T11:52:57+03:00 | test(git): give the delete/restore fixture repo a local git identity
5dc756eb6249e605a8b7fb39b9d347838d0e86ff | 2026-09-14T16:17:44+03:00 | docs: add 0.16 documentation and roadmap modernization audit
733cdf95cdfb7c809334efee641a6329c87802b8 | 2026-09-14T16:27:41+03:00 | docs: replace roadmap audit with code-grounded review
c1f6afb23ab32b295d296e24aa65c61f5a845d7f | 2026-09-14T16:35:23+03:00 | docs: add five-minute Telegram remote quickstart
3c85129ed87210a949336139ce8006be74001c99 | 2026-09-14T16:35:43+03:00 | docs: link Telegram quickstart from remote control guide
486380127e5b4580ae7198d96cbfeb466f28c1bb | 2026-09-14T19:05:05+03:00 | docs: capture remote wake architecture decision
33cec0f67156d16852bdbab3fb6300f721af2ea4 | 2026-09-14T19:13:25+03:00 | docs: add persistent agent jobs proposal and clarify parallel tool gate
ef684c7efc9abaf3ba0b086893bd67bc926b196a | 2026-09-14T19:20:26+03:00 | docs: refine persistent agent jobs architecture
5659099ae7120440f60b5de123e0a0d9f4b2a8db | 2026-09-14T19:48:37+03:00 | docs: reconcile README, delegation, commands and roadmap with 0.16 code
613d78417ddb9e9c42e11752497e72e7543e7b51 | 2026-09-14T23:41:30+03:00 | docs: sign off persistent agent jobs decisions D1-D7
4360c9310214f6b3a77701dd7fc5e70647d9cb37 | 2026-09-15T10:43:50+03:00 | fix(agent): retry a round that ends mid-thought instead of stopping silently
81ce97ab7134e8797a8876cfe334b1ed92e99ac8 | 2026-09-15T10:52:23+03:00 | feat(remote): auto-delete command replies; push the mid-thought stop notice
d63a71796c1aea3dfc26823ea06563474cc3d054 | 2026-09-15T11:43:02+03:00 | fix(webview): full-size image lightbox and transcript scroll pinning
320c975d2408482a9ac1206c03c5172075785e54 | 2026-09-15T11:51:52+03:00 | feat(instructions): raise the FORGE.md budget from 15,000 to 25,000 bytes
29185ee4487f5ede5a8f56881c8c7b36d5564fbc | 2026-09-15T11:52:03+03:00 | feat(tools): image_search — free reverse image search with thumbnails
8c996d64632adc72a33cbb9268a7a033881af3da | 2026-09-15T11:55:08+03:00 | chore: ignore generated-images/ output
4d2022da2d8b710f550945deb9dde38a4ab07e39 | 2026-09-15T11:56:21+03:00 | docs: tool schema growth plan, jobs A1 wake validation, lazy groups result
568db082a6c31c94cc3318d56393937d04685eda | 2026-09-15T12:14:03+03:00 | feat(image_search): Yandex engine, enlargeable previews, open-original link
59620c81462864de07d6d1316a4ba412281c4f2f | 2026-09-15T14:24:01+03:00 | feat(power): Phase A2 — recurring wake task, holdAwake, sleep_if_idle
0c07237c07deacbf6d71f92db8ba5cdaaa941de3 | 2026-09-15T18:17:48+03:00 | feat(compaction): compact between rounds of a running turn
9ab7cc6fcbd42ffcd6fa8bdbad6b204520e7eb02 | 2026-09-15T18:18:54+03:00 | docs: file size watchlist for future splits
b80379b907127a9e9a3bfdc64342bf983902ff2e | 2026-09-15T18:27:34+03:00 | refactor(sidebar): bring SidebarProvider under 500 LOC, drop max-lines disable
e2bd7dc7e4284299f6fcaa37a5941a929c579968 | 2026-09-16T01:54:36+03:00 | docs(jobs): flag A1 wake results as pre-hardware-change
a0d7b824112f1d2587cd336ebefac1ea7e793267 | 2026-09-16T03:38:07+03:00 | feat(jobs): Phase B1 — persistent agent job scheduler, outbox, checks
ee85ade49149ae41c182a775ce37da0887ace111 | 2026-09-16T05:02:08+03:00 | B2: manage_jobs agent tool for persistent agent jobs
111e887ec45d7da8ab86b2bbed12df0a6adfba20 | 2026-09-16T05:51:18+03:00 | B3: Telegram /jobs and /job commands for persistent agent jobs
25f60478c487d805a177a6fc20b649ad47449d24 | 2026-09-16T06:55:33+03:00 | B4: discuss chat seeding (manage_jobs discuss + /job chat)
af32ec5b713288de739ff89909ae9a0d7a8a10c5 | 2026-09-16T10:06:50+03:00 | B5: llamacpp_update action for persistent agent jobs
a4622b2c6019ad6085a481e93445c5411e143057 | 2026-09-16T11:52:55+03:00 | jobs: apply audit fixes (F1-F13) and split delivery out of the scheduler
bb9cefdf81b267ca17854d8784d5c7a7c43f6c87 | 2026-09-16T11:56:43+03:00 | release: 0.16.3 — jobs audit fixes
ddfdd6871d69278a50bab08e99e5fafe4e316f6c | 2026-09-16T13:18:51+03:00 | release: 0.16.4 — ask_live_session (agent bus as a tool)
c01d7113ad85e529817199b551343392febc5474 | 2026-09-16T13:57:45+03:00 | jobs: document why a dead restore target leaves the config on the failed tag
27412cc2018f8b987847f8c51369e204aa1b581d | 2026-09-16T15:53:21+03:00 | jobs: never stage or switch a build whose job was deleted mid-check
4e41aea532afff03b23e6b8ae02415ff78d66101 | 2026-09-16T16:03:12+03:00 | release: 0.16.5 — jobs delete-during-in-flight fix
654d99426a602cc2344adc2e25e5af5208753433 | 2026-09-16T17:06:37+03:00 | agent messaging: Forge, Claude Code and Codex talk directly (no watcher)
779abc4871bc0ac325be7dd44b2cc69b13b067c3 | 2026-09-16T17:10:20+03:00 | agent bus: keep pending questions out of old watchers' glob
d776e1f4bd2b8dfe095431c7ba594d70e230ddb4 | 2026-09-16T17:15:20+03:00 | unload: /unload frees only this chat's model; /unloadall frees everything
a290a65c7198c8cdc13888f7757a44863d97657b | 2026-09-16T17:15:24+03:00 | release: 0.16.6 — agent messaging without a watcher; per-chat /unload
2b302fa4422678f822f0cfddb3b403a3c5193a52 | 2026-09-16T17:18:05+03:00 | docs: agent messaging report and new-machine setup
d23c87ddcbbf18304ac1aaec3c84f0c043b1b159 | 2026-09-17T07:42:56+03:00 | config: embeddings.device, and a complete working example config
5e639ba32289a4641970e5c534bb740fc5e6f72b | 2026-09-17T08:01:13+03:00 | config example: warn that the example enables every permission
9a5ce2b2d038e1ce475f5b4dd906bf995be8261c | 2026-09-17T08:03:48+03:00 | release: 0.16.7 — embeddings.device, working example config, tool-schema budget gate
76bdd28ced54f11fc09054ad946ae16cc9483a66 | 2026-09-17T14:13:18+03:00 | remote: show the voice failure cause in chat, not just the reason code
4212fb358acf2b843a526de605f7da2c37db5af1 | 2026-09-17T14:16:15+03:00 | remote: say plainly that typed text replaces the voice transcript
5cc9ee79557d53ce61efa9411dc55e84abcaf916 | 2026-09-17T14:30:24+03:00 | remote: /voice toggles speech live; speech failures reach the chat
a3aa536b8f1b25229cbd04917f8fe22c1e775b26 | 2026-09-17T14:30:31+03:00 | chore: bump to 0.16.8 for a local build
21fca93cf17da34ccce44f11d93c6d7ab9d72e24 | 2026-09-17T19:37:28+03:00 | feat(models): add Nemotron benchmark profile
b6328da950b489fb5e229f91b1e7290bebb6d6de | 2026-09-17T19:54:45+03:00 | feat(bench): add Greek Nemotron evaluation
c0018746a5110a261d377a2e3394d2b3395d96e5 | 2026-09-17T22:06:00+03:00 | docs(bench): record Nemotron live results
b56e2041a89f69c2c9f12be701398438ed465942 | 2026-09-17T22:53:05+03:00 | docs(bench): record Nemotron Q8 control
60df762a705e36f17a8d239c421208789b2b467b | 2026-09-19T15:19:09+03:00 | fix(agents): resolve .cmd shim on Windows for ask_live_session Codex door
e8e5b2bdcf2fa5390a893f4a7229495236164f05 | 2026-09-19T15:21:05+03:00 | chore: bump to 0.16.9 for a local build (agent-mesh)
d34427fdbebcf7931706a3895ebc26f2323f4d77 | 2026-09-20T01:39:33+03:00 | agent-mesh P0: identity, ownership, transport truth (foundation)
1a6dcd505c102cf603e7c588e3476c0391071765 | 2026-09-20T02:11:24+03:00 | agent-mesh P1: scoped /status + auto turn-finished notice
096a33e3dd7c701a9f547488031a9ab4bb0e9dc1 | 2026-09-20T02:54:53+03:00 | agent-mesh P0: close Codex NO-GO findings (M2/M5/M6/M9/§2)
c1892bb70f684dd3f0caf7979700b38548699213 | 2026-09-20T03:43:52+03:00 | agent-mesh: fix P0 regressions (sleepSync DoS, exchangeScope leak) + P2 board
6799dc5f506e71e8e3a69e24169ecc370d6ecf1b | 2026-09-20T04:57:20+03:00 | agent-mesh P3: standby state machine + typed command surface + bus dispatch
98cafe1fc14067b4c5bf73930f29bfbf5d238db0 | 2026-09-20T13:42:07+03:00 | Aggregate remote compaction notices; raise tool-round ceiling to 1000
b2f58883baf933d5a96da0f59bba67c62bed2575 | 2026-09-20T15:12:13+03:00 | P4: Forge-owned persistent Claude stdio session
ea719e4048076839f9c1d1f11bd48671301bc5bb | 2026-09-20T15:29:38+03:00 | P4: Codex session discovery via app-server thread/list
b56221cb58bc1d43ef0629d662ec704a19bacfff | 2026-09-20T16:05:34+03:00 | fix: diagnose occupied llama server ports
729c46a148a89f17a2fc261d8805effd621601fc | 2026-09-20T16:06:48+03:00 | P5: FORGE.md + tool description cleanup (the hackjob)
6b7226a531081a4fbcbfd30260f64800afad93e3 | 2026-09-20T19:04:19+03:00 | agent-mesh: remediate Codex NO-GO review (F-01..F-12)
afaa1ce32e4d9cd976ab74e4a63f15c63d07a31d | 2026-09-20T19:20:31+03:00 | agent-mesh: F-14 lock the alias read-modify-write; extract shared M1 lock
ef72fe1c935c0f230d83710bf06bc7704c04f95d | 2026-09-20T20:03:52+03:00 | agent-mesh: cold-Codex review fixes + correctness corrections
8c882d02e254d3895ef46543dbf00a3d1c87c5eb | 2026-09-20T20:41:59+03:00 | release: 0.16.12 — agent mesh phases 1–5 + review remediation
64e4e693877f978b48c44eeaf11895036dd3400a | 2026-09-20T22:43:38+03:00 | agent-mesh: F-02 owner guard (pid-only isOwnerOf), F-08 turn-status lifecycle, idle-TTL owner check
bfe41fcc439180432a90a43048d0da0798583edd | 2026-09-21T01:50:11+03:00 | Finalize agent mesh and profile model selection
3294950998b2a282a435bdc9ae3317e1260235ef | 2026-09-21T02:02:49+03:00 | Add Telegram profile selection step
71fc85b9082b311452b5c0aa19be6c4b496cb181 | 2026-09-21T02:37:13+03:00 | feat: add Telegram contact workflow
8b993a29c571c86b17f82b816ac69bc2f5c5af5e | 2026-09-21T12:25:43+03:00 | jobs: fix llamacpp_update asset picking for current llama.cpp release layout
3647b54237b459c6fe530d6f800b56c22565d698 | 2026-09-21T12:52:46+03:00 | Add Telegram contact group chat workflow
2e88f0da08c491b5cf121526efd2131982d1b075 | 2026-09-21T13:20:28+03:00 | Keep contact owner requests in group
75ededd99b96c6c2b7eddf92ef5a2c2339e55c56 | 2026-09-21T13:23:33+03:00 | release: 0.16.13 — llamacpp_update asset-pick fix + opt-in jobs template
779cb5bab06957427eb8173ab6a8fbac8d73af51 | 2026-09-21T14:38:42+03:00 | fix: keep spaced CLI shim paths quoted through cmd /s /c (0.16.14)
c50fe400ce724d04081b5c31d8e26598f85b4484 | 2026-09-21T15:41:05+03:00 | mesh: zero-config participation — join, owned Codex default, FIFO asks (0.16.15)
6dcca574636d93b5cd6d80f0ba8a67074f47a650 | 2026-09-21T15:58:16+03:00 | mesh: forge.sh steer — Claude/Codex can interrupt Forge's running turn (0.16.16)
1bd4783806c3c2d10d1f86d20a304d1717c8a789 | 2026-09-21T16:28:16+03:00 | mesh: drop the owned-session consent dialog
e48a262ae9f7c5ce81d4e4795cd961c4cbbb0f86 | 2026-09-21T16:38:05+03:00 | remote: mirror a turn to a chat paired mid-turn
633975fd4816efb8c571a03c8b6108c76ff19081 | 2026-09-21T16:44:23+03:00 | mesh: mirror live-session answers to Telegram, per-round session log (0.16.17)
0ed286949bcd9f9b427ccbb107c7c1db0c4545aa | 2026-09-21T17:59:45+03:00 | Add `forge.sh who` — list every mesh participant and its state (§11)
e47976a9dc0caef52af0cef0bec971ad1f145354 | 2026-09-21T18:18:19+03:00 | forge.sh usage: derive the printed block instead of a fixed line range
6c8d4ad36eb2d62e167e48dcb3a5ba50e6343fb1 | 2026-09-21T18:20:25+03:00 | forge.sh usage: stop the block before implementation comments (0.16.18)
73d2755417155f0d9388b261b6d49aec9f663429 | 2026-09-21T19:08:33+03:00 | mesh run 1 fixes: forge.sh as a real file, forge.sh cancel, small follow-ups to Codex (0.16.19)
26e4c4692b46c0129de4a48fec73344118ed304d | 2026-09-21T20:29:13+03:00 | plan: agent-task jobs — a job that runs an unattended agent turn and reports to Telegram
9b7a5e6c9c6cc23da5b5d568c1c78213ad09f9bc | 2026-09-21T20:50:29+03:00 | plan: agent-task jobs run in one persistent chat per job, never deleted (HalluScribe)
7ed3420b9c98e16b14af10a4e898bed6b9051d03 | 2026-09-21T20:52:35+03:00 | plan: agent-task jobs use a free parallel slot instead of waiting for full idle
877900dea694a2a6e783803d451954f5503db84d | 2026-09-21T20:54:44+03:00 | plan: agent-task jobs reuse the model's existing caps; only optional max_minutes per job
73256e9bdc8f6a79dee1cd8958c3410ba4ecb9ca | 2026-09-21T21:18:32+03:00 | status phrases: three new ones
1f282423239418763c865c3e6d6c58246f45b058 | 2026-09-21T21:21:13+03:00 | plan: agent-task jobs — gap review: detached run, one report per run, discuss lockout, Qwopus trial scorecard
```
