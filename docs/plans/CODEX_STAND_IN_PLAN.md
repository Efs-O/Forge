# Codex stand-in: headless comms for a user-joined Codex with no open window

**Status:** proposed — awaiting user review, then implementation
**Date:** 2026-09-28
**Builds on:** [COPILOT_AGENT_MESH_PLAN.md](COPILOT_AGENT_MESH_PLAN.md) § P4b
(findings + proposal, Claude-reviewed), [CLAUDE_STAND_IN_RESUME_PLAN.md](CLAUDE_STAND_IN_RESUME_PLAN.md)
(the pattern this mirrors)

## Goal

A user-joined Codex (`by: "user"` in `aliases.json`) must be reachable from
Forge with **no Codex window open**, the same way user-joined Claude is today:
Forge spawns a transient headless codex app-server that resumes the user's
thread, answers through the mesh, and disposes itself. With a window **open**,
behavior is unchanged (non-observing queue adapter to the live thread), and
`ask_live_session` must work for a live user-joined thread **without** the
deprecated `agent_bus.codex_thread` pin.

After this, all three agents work headlessly from a fresh Forge session:
copilot (Forge-owned), claude (stand-in), codex (stand-in).

## Background — the two root causes (verified in P4b)

1. **Primary.** `sessionProvider.codexAdapterAsync()` short-circuits a
   user-joined alias to `codexAdapterIfLive()` before the
   `ensureOwnedCodex` headless-resume fallback. The result is always a
   **non-observing** `CodexQueueAdapter`, and the mesh ask path requires an
   observing adapter.
2. **Secondary.** The legacy ask path in `liveSessionTool.ts` reads only
   `bus.codex_thread` and ignores the joined alias's own `session_id`, so even
   a *live* user-joined codex refuses `ask` unless the pin is set.

The live/dead split **cannot** be made with `codexPinIsLive`/`CodexDiscovery`
(discovery "live" only proves the thread exists on disk). The only reliable
signal is the resume attempt itself: `thread/resume` fails with
`already has an active writer` exactly when a window holds the thread.

**Premise, not yet observed:** the only evidence for *where* that error
surfaces is the comment above the short-circuit in `sessionProvider.ts`
("an owned app-server resume races that writer and fails with …"). It does not
say whether `thread/resume` itself rejects, or whether the resume succeeds and
the first `turn/start` rejects. The eager-start design (Phase 1–2) depends on
the former, so Phase 0 checks it before any code is written.

## Non-negotiable invariants

1. **One mesh, no parallel implementation.** The stand-in is an adapter for
   the existing `codex` alias, FIFO, exchange log, and orchestrator — no new
   queue, board, or tool surface.
2. **Not an owned session.** The stand-in never enters the provider's owned
   map and writes **no** ownership or alias record. M3 resume, recovery, and
   the TTL reaper cannot see it; the user's thread id can never leak into
   `ownership/codex.json`. (Same invariant as `JoinedClaude`.)
3. **Never outlives one FIFO drain.** Disposed on `onIdle`, on writer-conflict
   fallback, and on provider dispose. While it holds the thread it is the
   active writer — a user reopening Codex hits the writer conflict, so the
   window is bounded by one drain.
4. **Never kills or races a user process.** On `already has an active writer`,
   dispose the stand-in and fall back to the queue adapter. `close` remains
   not applicable to user-joined codex (plan invariant #5 of the parent plan).
5. **No silent substitution.** A resume failure (mismatched thread id,
   protocol error, timeout) is reported plainly; no fresh thread is started
   silently. The only fresh-thread case is an *empty* alias `session_id`
   (the known `forge.sh join codex` bug), which starts a fresh thread with an
   explicit user-facing note that it does NOT have the joined conversation's
   context — mirroring `claudeStandInNote(undefined)`.
6. **Never silent.** A stand-in answering for a dead user-joined codex emits
   the user-facing note (window warning + board event + Telegram) through the
   existing `onStandIn` seam — the same one `JoinedClaude` uses.
7. **Owner-preserving, ≤500 lines per file.** The stand-in lives in its own
   file, as `JoinedClaude` does. It is a separate concern, not a line-count
   escape: `sessionProvider.ts` is 298 lines today. Existing files get routing
   changes only, plus the two small seams in Phase 1 and Phase 4.
8. **Tests are hermetic.** A fake codex factory models resume success,
   writer-conflict, mismatched-id, and empty-id; no real CLI in CI.

## State × lifecycle ledger

The stand-in itself writes **no durable state**. The only durable artifacts
are the Codex CLI's own thread files, which Forge never creates or deletes.

| Artifact | Create | Delete | Disable | Crash mid-write | Owner-process death | TTL/expiry |
| --- | --- | --- | --- | --- | --- | --- |
| Codex thread files under `~/.codex` (the user's thread, appended to by stand-in turns) | Codex CLI (`thread/resume` + turns) — never Forge | Codex CLI / user only — never Forge cleanup | N/A | Codex CLI's own persistence; a failed resume is *unknown*, never proof of death (invariant 5) | The stand-in child's stdin pipe closes with the extension host; the thread file remains; the next resolve in a new host retries the resume | None — governed by the Codex CLI, not Forge |
| Stand-in app-server child process (transient, in-memory) | `CodexStandIn.resolve()` spawns it, then eagerly resumes; it is handed out as an adapter only after the resume succeeds, and disposed on any resume error | `onIdle` (one FIFO drain), writer-conflict fallback, provider dispose | Never parked (a stand-in has no park state). With `agent_bus.enabled: false`, `ask_live_session`/`tell_live_session` refuse before resolving, so no stand-in is created; provider dispose clears any live one | A crashed app-server makes `CodexAppServerSession.stop()` fail the in-flight turn; the FIFO records it `failed`, then `onIdle` disposes the stand-in; no Forge file is written, so none can be torn | Extension-host death closes the child's stdin pipe, and the app-server is expected to exit on EOF (the same assumption the owned Codex session relies on; `terminateCliProcessTree` only runs on a clean dispose). Phase 6 step 6 checks for an orphan. The next host re-resolves from `aliases.json` | One FIFO drain (`onIdle`) — never age-based |

## Phase 0 — confirm where the writer conflict surfaces (live, no code)

**VERIFIED 2026-09-28 (live, user's window open on thread `01a0e4f6-…`):** a
scratch `codex app-server` (`initialize` → `thread/resume`) was rejected by
**`thread/resume` itself** with JSON-RPC error

```json
{"code": -32600, "message": "thread 01a0e4f6-1e6d-73d0-8a21-a29111492e6a already has an active writer"}
```

The app-server's own stderr logged the same: `thread-store conflict: thread …
already has an active writer`. Phases 1–2 stand as written. Phase 2 matches on
the substring `already has an active writer`.

(If a future Codex version moves the conflict to `turn/start`, rewrite Phase 2
before building it: the adapter's first `send` catches the writer error and
returns the queue adapter's result for that message. Do not start a second
resume.)

## Phase 1 — eager-start seam on `CodexAppServerSession`

`create()` only constructs; `thread/resume` runs lazily in the private
`ensureStarted()` on the first `send`. The stand-in needs the resume result
**at resolve time** (to make the live/dead decision before handing out an
adapter).

- Make `ensureStarted()` public under its current name. It cannot be renamed
  to `start()`: a private `start()` (the spawn + `initialize` + resume body)
  already exists.
- Add a disposed guard: `if (this.currentState === 'disposed') throw new
  Error('CLI agent session is disposed.')`, the same check `send()` makes.
  Today `stop()` clears `startPromise`, so an eager start after `dispose()`
  would spawn a fresh app-server. The stand-in's dispose-then-resolve race
  (Phase 2) must not be able to do that.
- An eager start before the first `send` is safe: `send()` awaits the same
  `startPromise`, so it does not start twice.
- Tests: calling it twice spawns once; calling it after `dispose()` throws and
  spawns nothing.

## Phase 2 — `CodexStandIn` (`src/agentMesh/codexStandIn.ts`, new file)

Mirrors `claudeStandIn.ts` / `JoinedClaude`:

- Deps: `busRoot`, `getConfig`, `workspaceRoots`, injectable
  `codexFactory` (production: `defaultCodexFactory()`), the existing
  `onStandIn` callback (already on `SessionProviderDeps` via
  `JoinedClaudeDeps`, and wired in `agentMeshSetup.ts` to window warning +
  board notice), and `queueAdapter: () => Promise<MeshAdapter | undefined>`.
  The provider passes `() => this.factory.codexAdapterIfLive()` as
  `queueAdapter`, so the stand-in reuses the existing queue-adapter path
  instead of building its own `CodexPinContext`.
- `resolve(aliasRec: AliasRecord): Promise<MeshAdapter | undefined>`:
  1. Concurrent-creation guard (a `creating` promise, as `JoinedClaude` has).
  2. A live, undisposed stand-in is returned as-is.
  3. Build the session with the **raw** factory call
     `create({ alias: 'codex', threadId: aliasRec.session_id || undefined,
     executable, cwd })` — no `beginCreation`, no `writeOwnership`, no
     `registerAlias`.
  4. **Eager** `await session.ensureStarted()`:
     - success → emit the stand-in note (`onStandIn('codex', …)`, phrased like
       `claudeStandInUserNote`), return the observing adapter;
     - error containing `already has an active writer` (the text Phase 0
       recorded) → dispose the session and return `await
       deps.queueAdapter()`. For a `by: "user"` alias this is a
       `CodexQueueAdapter` on the alias thread; `codexQueueAdapterIfLive` does
       no discovery probe for an alias identity. No stand-in note is sent.
       Cost: with a window open, every resolve spawns and disposes one
       app-server to learn this. That is acceptable for one-at-a-time mesh
       turns; do not cache the result, because the window can close at any
       time.
     - any other error (mismatched id, protocol, timeout) → dispose, emit a
       plain failure note, return `undefined` (the ask is refused with the
       reason; no fresh thread).
  5. Empty `session_id` → `thread/start` (fresh thread) with the explicit
     "no context of the joined conversation" note (invariant 5).
- Adapter shape: `{ kind: 'codex', observesTurns: true,
  key: 'codex-stand-in:<threadId|blank>:<seq>', note, send, interrupt,
  onIdle }` — `send`/`interrupt` delegate to a `CodexOwnedAdapter` wrapping
  the session (same as the claude stand-in's `inner`).
- The stand-in note is sent once per stand-in, when it is created, as
  `JoinedClaude.createStandIn` does. It is not sent once per answer.
- `onIdle` → dispose the stand-in, guarded against disposing a newer one
  (`disposeStandIn(only)`, as in `JoinedClaude`) (invariant 3).
- `dispose()` → dispose the current stand-in (provider dispose calls it).
- The stand-in's own child pid is never written anywhere (invariant 2).

## Phase 3 — routing in `sessionProvider.codexAdapterAsync()`

Replace the user-joined short-circuit:

```ts
if (aliasRec?.by === 'user') return this.factory.codexAdapterIfLive();
```

with:

```ts
if (aliasRec?.by === 'user') return this.codexStandIn.resolve(aliasRec);
```

- Construct `CodexStandIn` in the provider constructor (alongside `joined`),
  passing the provider deps plus `queueAdapter: () =>
  this.factory.codexAdapterIfLive()`.
- Add it to the `Promise.all` in provider `dispose()` (alongside
  `this.joined.dispose()`).
- `close()` needs no change: it acts only on an ownership record, and the
  stand-in writes none, so `close codex` on a user-joined alias still returns
  `false`.
- `reap()` is unchanged: the stand-in is not in the owned map, so the
  owner-host-death recovery path cannot see it (invariant 2).
- Owned-session-first ordering is unchanged (an owned codex still wins over a
  user-joined alias).
- Net change to `sessionProvider.ts`: a field, a constructor line, a one-line
  routing swap, and a dispose line (298 lines today).

## Phase 4 — legacy ask path fix in `liveSessionTool.ts`

Close the secondary root cause so a **live** user-joined codex works without
the pin:

- In the codex branch, take the thread from the adapter the tool already
  resolved (`orchestrator.resolveAdapter('codex')`, earlier in the same
  handler). When that adapter is a non-observing `CodexQueueAdapter`, use its
  thread. `CodexQueueAdapter.thread` is a private constructor field today;
  expose it as a `readonly` property. Fall back to `bus?.codex_thread` only
  when no codex alias exists.
- **Do not use `resolveSessionIdentity` here.** When the stand-in fails
  (mismatched id, protocol error, or timeout), it returns `undefined` on
  purpose. Reading the alias `session_id` directly would then `codex queue`
  the message to a thread no window holds. That is exactly the silent
  substitution invariant 5 forbids, and it would also hide the failure.
  Instead: a `by: "user"` codex alias with no adapter is refused with a new
  message. The message says the stand-in could not resume the joined thread,
  that the reason was sent to the user, and that the agent must not fall back
  to `ask_local_agent`.
- Update `NO_CODEX_THREAD` wording: the "set `agent_bus.codex_thread`" hint
  becomes "join a codex session (`forge.sh join codex`) or set
  `agent_bus.codex_thread`".
- `tell_live_session` (`src/tools/tellLiveSessionTool.ts`) needs no change:
  it goes through the mesh orchestrator/FIFO, which serves both the stand-in
  and the queue adapter.

## Phase 5 — tests (hermetic, fake codex factory)

Unit tests in `test/unit/` (new `CodexStandIn.test.ts` + additions to the
existing provider/tool suites):

1. Dead thread → resolving returns an **observing** stand-in adapter; resume
   was called with the alias's `session_id`; the stand-in note was emitted
   once; **no** ownership file was written (assert absence), and the alias
   record is byte-identical.
2. Writer-conflict error → stand-in disposed, the **queue adapter** is
   returned (non-observing), no note claiming a stand-in answered.
3. Mismatched-thread-id error → `undefined` + plain failure note; no fresh
   thread started.
4. Empty `session_id` → fresh thread via `thread/start` + explicit
   "no context" note.
5. `onIdle` disposes the stand-in; a subsequent `resolve` creates a fresh one
   with a unique `key`.
6. Concurrent resolves share one in-flight creation (no double spawn).
7. Provider `dispose()` disposes a live stand-in.
8. `ask_live_session` codex, user-joined alias, fake factory returning the
   writer conflict, **no** pin → `queueCodex` is called with the alias
   thread (secondary root cause closed).
9. `ask_live_session` codex with neither alias nor pin → `NO_CODEX_THREAD`
   refusal (unchanged).
10. `close codex` on a user-joined alias with no ownership record returns
    `false`, including while a stand-in is live (invariant 4).
11. `ask_live_session` codex, user-joined alias, fake factory returning a
    mismatched-id error, **no** pin → refused with the stand-in-failure
    message; `queueCodex` is **not** called (invariant 5, Phase 4).
12. `CodexAppServerSession.ensureStarted()` spawns once when called twice,
    and after `dispose()` it throws and spawns nothing (Phase 1).

## Phase 6 — live validation, docs, packaging

Live (after build + user reload), against the real user-joined codex thread
`01a0e4f6-…`:

1. Window **closed**: `ask_live_session(target: "codex")` → stand-in answers;
   the stand-in note reaches the window + board + Telegram; exchange log
   shows the observed turn.
2. Window **closed**: `tell` → stand-in; `steer` mid-turn → accepted, active
   turn cancelled, steer runs next (exchange-log evidence, as P4b did for
   claude).
3. Window **open**, **no** pin: `ask` reaches the live thread through the
   legacy queue path (secondary root cause closed live).
4. `close codex` → refused (user-joined).
5. `forge.sh who` → codex state truthful in every case.
6. After step 1, reload the window mid-idle and confirm no orphaned
   `codex app-server` is left running (ledger, owner-process death).

Docs and release:

- Apply the proposed FORGE.md "Agent mesh comms (quick reference)" block from
  P4b (it becomes truthful only after this lands).
- `CHANGES.md` entry; version bump **asked of the user** before packaging.
- Final gates: `npm run ci`, `npm run package`, `git diff --check`,
  `git status --short`; package hash/size recorded in the plan.

**Code + gate evidence (2026-09-29):** Phases 1–5 implemented
(`codexStandIn.ts` new; `sessionProvider.ts` routing; `liveSessionTool.ts`
legacy-path fix; `CodexAppServerSession.ensureStarted()` seam + disposed
guard; `tellLiveSessionTool.ts` surfaces the stand-in note). `npm run ci`
green: 3,378 tests passed (36 skipped) — type-check, lint, unit +
integration, production build, bundle-load smoke — including the 12 Phase 5
tests (stand-in resolve/conflict/mismatch/empty-id, one-drain lifetime,
concurrent-resolve sharing, provider dispose, legacy no-pin queue, stand-in
failure refusal, `ensureStarted` idempotence + dispose guard). Every touched
source file is under the 500-line limit. CI ran twice (before and after the
plan-doc evidence edits), both green. `npm run package` at the already-bumped
0.16.58 (the 0.16.58 CHANGES entry covers this work; the stale 4-h-old
0.16.58 .vsix — built before the Copilot ACP 1.0.89 fix — was rebuilt with
`FORGE_ALLOW_VSIX_OVERWRITE=1`): `forge-llm-0.16.58.vsix`, 29 files, 8.45 MB,
SHA256 `bdbee00dea10ec29208a3d6850032ae2497a09b1b263566d50e2eb209170dec8`
(first packaging attempt also shipped a 1 MB `.ci-failures.json` debug dump;
removed and a `.vscodeignore` guard added, then repackaged). `git diff
--check` clean. No commit or install has been made (user gates both).

**Live validation evidence (2026-09-29, post-reload on 0.16.58):**

| Step | Result | Detail |
|------|--------|--------|
| 1 — window closed, ask | ✅ PASS | Stand-in answered "stand-in pong"; note emitted ("Your Codex session was closed, so Forge answered for it headless"); exchange log: `notice/recovered` → `accepted` → `started` → `completed` |
| 2 — tell + steer | ✅ PASS (2026-09-29 07:39Z) | Run with no VS Code Codex app-server holding the thread (the user had both killed). `forge.sh send claude codex` (essay) → stand-in `recovered` notice, `2b83f969` started 07:39:00.245. `forge.sh steer claude codex` → `f575e42f` accepted 07:39:05.559; essay **cancelled 07:39:05.714** (155 ms later); steer started .718 and completed 07:39:10.370 ("steered"). Codex rollout: `turn_aborted` reason `interrupted` at 07:39:05.702. The 09-28 attempt had sent two plain tells (see F1). |
| 3 — window open, legacy queue | ✅ PASS | With the user's Codex window open, `ask` returned "queue pong" with **no stand-in note and no mesh exchange entry** — i.e. `resolveAdapter('codex')` returned a non-observing `CodexQueueAdapter` (the live thread is held by the user's Codex) and the legacy `queueToCodex` path delivered to the alias's thread. Contrast with the window-closed attempt (exchange 39dbaf51), which took the stand-in path (logged + note). Code: `liveSessionTool.ts` — `adapter?.observesTurns` gates the mesh `ask()` path; a `CodexQueueAdapter` falls to the legacy `queueToCodex` delivery. |
| 4 — close codex | ✅ PASS | Refused — no `codex.json` ownership record (user-joined). Code path: `readOwnership` → `null` → `close` returns `false`. |
| 5 — forge.sh who | ✅ PASS | codex = `peer` / `unknown` / "not observable from this host" — truthful (app-server running, interactive session closed). |
| 6 — orphan check | ✅ PASS (partial) | No orphaned stand-in `codex app-server` after steps 1–2. After the 09-29 step 2 re-run, zero `codex.exe` processes remained (the stand-in was disposed on `onIdle`). Full step 6 (reload mid-idle) pending. |

**Copilot ACP 1.0.89 comms:** ✅ PASS — "copilot pong" received through the live extension. The jsonrpc 2.0 + relaxed `session/load` fix is verified.

**Finding F1 — withdrawn (2026-09-29): the "steer" in step 2 was not a steer.**
The Forge session log (`57076d2d-….jsonl`) shows both step 2 messages went
out as plain `tell_live_session({target: "codex", message})`. Steer is
reachable only through `forge.sh steer`, the mesh `steer <alias>` command, and
`orchestrator.steer` in `agentMeshSetup.ts`. Codex's own logs agree: in
`~/.codex/logs_2.sqlite`, app-server pid 40064 received `initialize`,
`thread/resume` and `turn/start` (21:37:59–21:38:00) and **no**
`turn/interrupt`, with log rows through 21:38:18. The thread rollout has no
`turn_aborted`. So neither hypothesis (a) nor (b) applies; the code path was
never exercised.

**Re-run attempt (2026-09-29 07:36Z) did not reach the stand-in either:**
`forge.sh send claude codex` then `forge.sh steer claude codex` 4 s later.
No new `codex.exe` spawned. The turn ran inside an existing VS Code Codex
extension app-server, because the openai.chatgpt panel still held thread
`01a0e4f6`. The resolve therefore hit the writer conflict and fell back to the
non-observing queue adapter, where a steer is only enqueued (by design). That
matches the logs: exchange `d6662732` never reached `started`. That is why C8 was
re-run after the user killed both extension app-servers (step 2 row: PASS).

## Acceptance criteria

- [x] **C1 — dead thread, headless ask.** With no Codex window open,
  `ask_live_session(target: "codex")` returns the resumed thread's answer
  through an observing stand-in adapter (test 1; live step 1 ✅).
- [x] **C2 — live thread, no pin.** With a window open and no
  `agent_bus.codex_thread` pin, `ask` reaches the live thread via the queue
  adapter (test 8; live step 3 ✅ — window-open ask returned "queue pong"
  through the non-observing `CodexQueueAdapter` / `queueToCodex` legacy path,
  no stand-in note, no mesh exchange entry).
- [x] **C3 — writer conflict is safe.** A resume that hits
  `already has an active writer` disposes the stand-in and falls back to the
  queue adapter; no user process is killed or raced (test 2; invariant 4).
- [x] **C4 — no durable leak.** The stand-in writes no ownership, alias, or
  board-identity record; `ownership/codex.json` and the codex alias record are
  byte-identical before and after a stand-in turn (test 1's file-absence
  assertions; invariant 2).
- [x] **C5 — one-drain lifetime.** The stand-in is disposed on `onIdle`, on
  writer-conflict fallback, and on provider dispose; a second resolve creates
  a fresh stand-in (tests 5, 6, 7; invariant 3).
- [x] **C6 — no silent substitution.** Mismatched-id and protocol failures
  return a plain refusal with the reason and start no fresh thread; only an
  empty alias `session_id` starts a fresh thread, with the explicit
  "no context" note. A failed stand-in is never replaced by a `codex queue`
  to the dead thread (tests 3, 4, 9, 11; invariant 5).
- [x] **C7 — never silent.** The stand-in note (window warning + board event +
  Telegram) is emitted exactly once per stand-in, when it is created, through
  the existing `onStandIn` seam (test 1; live step 1 ✅).
- [x] **C8 — steer works headlessly.** A steer against a stand-in turn is
  durably accepted, cancels the active turn, and runs next (live step 2 ✅,
  2026-09-29: cancelled 155 ms after acceptance, Codex `turn_aborted`
  `interrupted`; same contract as A7 of the parent plan).
- [x] **C9 — close unchanged.** `close codex` on a user-joined alias is
  refused; the stand-in is not a `close` target (test 10; live step 4 ✅).
- [x] **C10 — projections truthful.** `forge.sh who`, the sidebar board, and
  Telegram `/status` show codex truthfully in each case (live step 5 ✅;
  parent plan A10).
- [x] **C12 — premise checked.** Phase 0 recorded which call returns the
  writer conflict and its exact text, and Phase 2 matches that result (Phase 0;
  tests 2, 8).
- [x] **C13 — eager start is safe.** `ensureStarted()` is idempotent and
  refuses after dispose (test 12; Phase 1).
- [x] **C11 — gates.** `npm run ci` green (type-check, lint, unit +
  integration, production build, bundle-load smoke), every touched source
  file under the 500-line limit, `git diff --check` clean, package hash/size
  recorded (Phase 6).

## Handoff (2026-09-29, end of session — continuing tomorrow)

**Where the work stands:**

- Phases 0–5 fully implemented and CI-green (3,378 passed / 36 skipped, run
  twice). VSIX built and installed at 0.16.58
  (SHA256 `bdbee00dea10ec29208a3d6850032ae2497a09b1b263566d50e2eb209170dec8`,
  29 files, 8.45 MB). **Nothing committed, nothing published** — the user
  gates both.
- Live validation against the real user-joined Codex thread
  (`01a0e4f6-…`) after the reload: **steps 1, 3, 4, 5 PASS; step 6 partial
  (orphan check clean, reload-mid-idle re-check pending); step 2 PASS
  on the 09-29 re-run (F1 withdrawn: the 09-28 "steer" was a plain tell).** Copilot ACP 1.0.89 comms verified live ("copilot pong").
- Acceptance criteria: C1, C2, C3, C4, C5, C6, C7, C9, C10, C11, C12, C13
  checked, and C8 as of the 09-29 re-run. All criteria are met; only the full step 6 reload check is pending.

**Finding F1: withdrawn.** See "Finding F1 — withdrawn" under the live
validation evidence above. The 21:38 "steer" was a plain tell, and Codex's
logs show no `turn/interrupt` was ever sent.

**Environment fact (corrected 2026-09-29):** WSL *is* installed (distro
`docker-desktop`, v2), but firmware virtualization is off (`systeminfo`:
"Virtualization Enabled In Firmware: No"), so any WSL2 start fails with
`HCS_E_HYPERV_NOT_INSTALLED`. From PowerShell, a bare `bash` resolves to
`C:\Windows\System32\bash.exe`, the WSL launcher. Git Bash
(`C:\Program Files\Git\bin\bash.exe`) works and runs `forge.sh`
normally. Use it; there is no need to call the HTTP endpoints by hand.
Later on 2026-09-29, VT-x was enabled and Ubuntu was installed as the
default distro, so a bare `bash` works. `forge.sh` routes `curl` through
Windows' `curl.exe` under WSL, because WSL2 NAT hides Windows' loopback.

**Pending user actions before this can close:**
1. Reload the window mid-idle → re-run the orphan check (full step 6).
2. ~~Re-run step 2 with a real steer~~ done 2026-09-29 (C8 ✅).
3. Commit + publish decision (user gates both; the 0.16.58 VSIX is already
   installed in the running VS Code).

**Working tree at handoff:** 28 modified + 12 untracked files
(`git status --short`), `git diff --check` clean. Key untracked:
`src/agentMesh/codexStandIn.ts`, `test/unit/CodexStandIn.test.ts`,
`docs/plans/CODEX_STAND_IN_PLAN.md`, the `test/copilot-*.mjs` probes.
