# Persistent Agent Jobs — guide and test plan

A **job** is a small, durable thing that runs on a schedule, checks something,
and reports (or acts) when it changes. It survives restarts, runs while the
machine is asleep (it can wake the box), and is controlled from VS Code **or**
from Telegram. A job is *data* you edit — not a config knob — so it lives in
`~/.forge/jobs/`, outside the chat-session store.

This document is both the user guide and the manual test plan. The numbered
procedure at the end is the one you follow on this machine; it includes the
**AC10 named manual step** the plan requires (a real llama.cpp release, staged
in `prepare`, approved, then one `apply` run).

---

## 1. Turn the scheduler on

Jobs are off unless you opt in. Add a `jobs:` block to your `config.yaml`
(`.forge/config.yaml` in the workspace, or the global one):

```yaml
jobs:
  enabled: true
  # Outbound network gate (D5). A job may only fetch from a host listed here.
  # Empty = no job may touch the network at all.
  allowed_hosts:
    - api.github.com
    - objects.githubusercontent.com
  # How many jobs may run at once. 1 is safe for a single GPU.
  max_concurrent: 2
```

- `enabled: false` (or the block absent) → no scheduler, no lease, no
  `manage_jobs` tool, no `/jobs` Telegram commands.
- `allowed_hosts` is the **only** way a job reaches the network. A
  `llamacpp_update` job needs `api.github.com` (release metadata) **and**
  `objects.githubusercontent.com` (the CDN the asset download 302-redirects
  to — the gate is re-checked at every redirect hop).
- `max_concurrent` 1–8. The scheduler runs at most this many jobs per tick.

After editing, **Reload Window** so the scheduler picks up the change (a config
hot-reload also reconciles it, but a reload is the clean way to start).

---

## 2. What a job looks like

A job is one JSON file at `~/.forge/jobs/<id>.json`. Its shape (v1):

```jsonc
{
  "version": 1,
  "id": "llama-nightly",          // stable id = file name; [A-Za-z0-9._-]+
  "name": "llama.cpp nightly",    // what you call it
  "enabled": true,
  "wake": false,                  // may this job wake the machine from sleep?
  "after": "stay_awake",          // "stay_awake" | "sleep_if_idle" (D6)
  "schedule": { "kind": "daily", "at": "06:00" },
  "check": {
    "kind": "github_release",
    "repo": "ggml-org/llama.cpp",
    "channel": "prerelease"       // "latest" (default) | "prerelease"
  },
  "on_change": { "kind": "notify" },
  "action": null,                 // null, or a llamacpp_update (below)
  "created_at": 0,
  "updated_at": 0
}
```

You almost never hand-write this — `manage_jobs` does. But you can: write the
file (or edit one) and the scheduler's store watch picks it up on the next tick.

### Schedules (exactly one)

| Kind | Shape | Notes |
| --- | --- | --- |
| `interval` | `{ "kind": "interval", "minutes": 60 }` | Minimum **15** minutes (below that a GitHub job hammers the API). |
| `daily` | `{ "kind": "daily", "at": "06:00" }` | 24-hour clock, `00:00`–`23:59`. |
| `weekly` | `{ "kind": "weekly", "days": ["Mon","Fri"], "at": "06:00" }` | One or more of `Mon`…`Sun`. |

`wake: true` (daily/weekly only) arms a Windows Task Scheduler entry so the box
wakes at the due time. `after: sleep_if_idle` re-suspends after the run if
nothing happened and no input has arrived (D6).

### Checks (exactly one)

| Kind | Shape | What it watches |
| --- | --- | --- |
| `github_release` | `{ "kind": "github_release", "repo": "owner/name", "channel": "latest" }` | A repo's newest release. `channel: "prerelease"` watches the nightly `bNNNN` builds (what `/releases/latest` never returns). Optional `asset_pattern` (a `*`-glob on asset file names). |
| `github_issue` | `{ "kind": "github_issue", "repo": "owner/name", "issue_number": 123 }` | One issue's state (open/closed/comments). |
| `disk_space` | `{ "kind": "disk_space", "path": "C:\\", "min_free_gb": 20 }` | Free space on a path; reports when it drops below the floor. |

The first run of any job only **records a baseline** — it never reports
"changed". A change is reported on a later run when the observation differs.

### On change (exactly one)

| Kind | Shape | Behaviour |
| --- | --- | --- |
| `notify` | `{ "kind": "notify" }` | Report the check's own one-line summary. |
| `summarize` | `{ "kind": "summarize", "focus": ["release_notes"] }` | Run a no-tools model call to summarize the change. Focus: 1–3 of `release_notes`, `breaking_changes`, `cuda`, `assets`. Runs **only when idle** — if a turn is streaming, the change is recorded and summarized on the next idle tick. |

### The one mutating action: `llamacpp_update`

```jsonc
"action": {
  "kind": "llamacpp_update",
  "mode": "prepare",                     // "prepare" (ask) | "apply" (auto)
  "asset_pattern": "llama-*-bin-win-cuda-*-x64.zip"
}
```

This is the only job action that **changes the machine**: it downloads a
llama.cpp release, verifies the SHA-256 against the release API, extracts it,
smoke-tests it, and — when idle — switches `llama_server.binary` in
`config.yaml` and restarts the backend. On a post-check failure it restores the
previous binary.

- `mode: "prepare"` — stops after the smoke test and waits for you to approve
  with `/job <n> approve` (24 h expiry). **Use this for the first run.**
- `mode: "apply"` — switches automatically when the box next goes idle.
- The check must be a `github_release` with `channel: "prerelease"` (the tag
  comes from the observation).
- `asset_pattern` is a `*`-glob. A literal `{tag}` is **not** substituted —
  write `*` where the tag varies (e.g. `llama-*-bin-win-cuda-*-x64.zip`).

---

## 3. Controlling jobs

### In VS Code — the `manage_jobs` tool

The agent tool `manage_jobs` creates, reads, updates, pauses, and deletes jobs.
The model can only do what your permissions allow: create/update are derived as
read/write, **delete is `dangerous`** (it needs an explicit approval). It
resolves a job by exact id, or by a unique substring of the name, and refuses an
ambiguous match. It can also open a **discuss chat** for a job (`discuss`),
which seeds a normal conversation with the job's recent run history.

### On Telegram — `/jobs` and `/job <n>`

When a chat is bound to the workspace and Telegram is connected:

- `/jobs` — lists the jobs, numbered, with their schedule and last state.
- `/job <n>` — shows one job's detail (schedule, last run, last observation).
- `/job <n> run` — run it now (crosses the schedule; idempotent — a second
  request before it's consumed does not double-run it).
- `/job <n> pause` / `/job <n> resume` — toggle `enabled`.
- `/job <n> approve` — approve a `prepare`-mode staged `llamacpp_update` so the
  next idle tick performs the switch.
- `/job <n> chat` — open the discuss chat for the job.

A confirmation that was issued for a job that changed in the meantime is
**refused** (the `updated_at` re-check), so a stale `/job <n> approve` cannot
switch the wrong job.

---

## 4. Manual test procedure (run this on the machine)

Each step names what you should see. Stop and report if a step does not match —
that is a finding, not a setup mistake (unless noted).

### A. Scheduler starts and holds the lease

1. Add the `jobs:` block from §1 to `config.yaml`, **Reload Window**.
2. Open a second VS Code window on the same workspace.
3. **Expect:** exactly one window owns the scheduler (the lease). Create a job
   in *either* window with `manage_jobs`; it appears in both, because the store
   is shared on disk and the lease holder watches it. The non-owner window's
   `manage_jobs` still edits the files; the owner's scheduler picks up the
   change.

### B. A watch-only job runs and reports a change

4. Create a job: `github_release` on a small repo you can push to (or a repo
   with frequent releases), `on_change: notify`, `schedule: { kind: "interval",
   "minutes": 15 }`, `wake: false`.
5. **Expect:** the first run records a baseline and reports **no** change.
6. Trigger a change (push a release / bump the watched thing).
7. **Expect:** within one interval, a run row is appended to
   `~/.forge/jobs/runs/<id>.jsonl` with `outcome: "ok"`, `changed: true`, and a
   notification is delivered (a VS Code toast in the scheduler window, and — if
   Telegram is bound — a message in the owner chat via the outbox).
8. **Expect:** the next run with no new change reports `changed: false`.

### C. Backoff on repeated failure

9. Point a job's check at a host **not** in `allowed_hosts` (or a repo that
   404s), so every run fails.
10. **Expect:** after 3 consecutive failures the job is backed off —
    `next_due_at` is pushed out, a run row with `outcome: "skipped"` and
    `summary: "backed off after 3 failures: …"` is written, and the failure is
    **reported once** (not on every subsequent failed run). A later success
    reports "recovered after N consecutive failures".

### D. `run_now` crosses the schedule and is idempotent

11. With a paused (`enabled: false`) job, send `/job <n> run` (or `manage_jobs`
    `run_now`).
12. **Expect:** the job runs on the next tick even though it is not due and is
    paused — an explicit request overrides the schedule. Sending it again before
    it is consumed does **not** double-run it (the marker is written with a
    create-only flag and consumed before the run).

### E. The discuss chat

13. `manage_jobs` `discuss` (or `/job <n> chat`) for a job that has run at
    least once.
14. **Expect:** a new conversation opens, seeded with the job's name, schedule,
    and recent run history. The conversation id is persisted in the job's state,
    so a second `discuss` **reuses** the same conversation instead of opening a
    new one.

### F. The `llamacpp_update` action — the AC10 named step

This is the one validation the plan requires and the unit tests cannot do (they
use fakes). It exercises the real download → verify → extract → smoke-test →
switch → post-check path against a real release.

15. **Prepare the job.** Create a job:
    - `check`: `{ "kind": "github_release", "repo": "ggml-org/llama.cpp",
      "channel": "prerelease" }`
    - `on_change`: `{ "kind": "notify" }`
    - `action`: `{ "kind": "llamacpp_update", "mode": "prepare",
      "asset_pattern": "llama-*-bin-win-cuda-*-x64.zip" }`
    - `schedule`: `{ "kind": "interval", "minutes": 15 }`
    - Ensure `allowed_hosts` includes **both** `api.github.com` and
      `objects.githubusercontent.com`.
16. **Force a change** so the check reports one (or wait for a new nightly).
17. **Expect (staging):** the run downloads the `llama-b<tag>` and
    `cudart-llama-b<tag>` zips, verifies both SHA-256 digests, extracts them into
    `%LOCALAPPDATA%\Forge\llama.cpp-<tag>\`, and smoke-tests the binary
    (`--version` reports the tag, `--list-devices` runs). The downloaded zips
    are then deleted. A `staged/<id>.json` is written with
    `switch_pending: false`, and you are told to reply `/job <n> approve`.
    **Nothing in `config.yaml` has changed yet.**
18. **Approve it.** Send `/job <n> approve`.
19. **Expect:** the staged build is flagged `switch_pending: true`. On the next
    **idle** tick (no turn streaming), the scheduler writes
    `llama_server.binary` to the new build and restarts the backend.
20. **Expect (post-check):** the backend comes up healthy on the new binary,
    the staged file is cleared, and you are told "switched
    llama_server.binary to b<tag>".
21. **Verify the rollback path (optional, destructive):** repeat 15–20 but make
    the post-check fail (e.g. point the action at a tag whose binary will not
    start). **Expect:** the previous `llama_server.binary` is restored, the
    backend is restarted on it, and you are told the post-check failed and the
    previous binary was restored. `config.yaml` must never be left pointing at a
    build that does not serve.
22. **Expect (cleanup):** after a successful stage, `%LOCALAPPDATA%\Forge\staging\`
    holds **no** leftover zips for that release, and a failed stage leaves **no**
    partial `llama.cpp-<tag>\` directory (so a retry of the same tag is not
    blocked at the "already exists" guard).

### G. Wake (daily/weekly, optional)

23. Set a daily job to `wake: true` with an `at` time a few minutes ahead, and
    put the machine to sleep.
24. **Expect:** the Windows Task Scheduler entry `ForgeScheduledWake` fires, the
    box wakes, the job runs once (marked `late` in its run row), and — if
    `after: sleep_if_idle` and nothing is busy — the box may suspend again.
    Disabling the job (or all jobs) deletes the task, so no stale task keeps
    waking the machine.

---

## 5. Where the state lives

| Path | What |
| --- | --- |
| `~/.forge/jobs/<id>.json` | The job definition. |
| `~/.forge/jobs/state/<id>.json` | Mutable run state (last run, observation, backoff, conversation id). |
| `~/.forge/jobs/runs/<id>.jsonl` | Append-only run log. |
| `~/.forge/jobs/run_requests/<id>` | A `run_now` marker (consumed before the run). |
| `~/.forge/jobs/staged/<id>.json` | A staged `llamacpp_update` build (24 h TTL). |
| `~/.forge/jobs/outbox/<id>.json` | A coalesced, not-yet-delivered notification. |
| `~/.forge/jobs/jobs-scheduler.lease.json` | The scheduler lease (one owner). |
| `%LOCALAPPDATA%\Forge\llama.cpp-<tag>\` | An extracted build (kept; old builds are never deleted). |
| `%LOCALAPPDATA%\Forge\staging\` | Downloaded release zips (deleted after a stage). |

Deleting a job removes its definition, state, run log, run request, **staged-build
record (`staged/<id>.json`), and outbox item** — so a deleted job cannot still
switch the backend or deliver a stale message. The extracted build folder under
`%LOCALAPPDATA%\Forge\` is **kept**: it is a normal build and may still be
referenced by `llama_server.binary`.
