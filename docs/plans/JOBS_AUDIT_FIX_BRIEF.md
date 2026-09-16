# Jobs audit — fix brief (local agent's half)

**Date:** 2026-09-16 · **Source:** [PERSISTENT_AGENT_JOBS_AUDIT.md](PERSISTENT_AGENT_JOBS_AUDIT.md)
· **Status:** not started

This is the standing task brief for the local agent's half of the audit fixes.
Two agents work this tree **in parallel**, partitioned by file. Read the
partition before touching anything; if you have lost the thread mid-task, this
file is the source of truth for what you own and what you must not touch.

---

## File partition (the whole point — do not cross it)

| Owner | Files |
| --- | --- |
| **Local agent (this brief)** | `src/jobs/actions/llamacppUpdate.ts`, `actions/stagedBuild.ts`, `actions/llamacppAction.ts`, `src/jobs/jobSchema.ts`, `test/unit/LlamacppUpdate.test.ts`, `docs/OWNERS.md`, `docs/JOBS.md` (new) |
| **Claude Code (other agent)** | `src/jobs/JobStore.ts`, `JobScheduler.ts`, `JobOutbox.ts`, `jobsFetch.ts`, `src/jobs/checks/*`, `src/vscode/jobsSetup.ts`, `src/remote/*`, and `test/unit/JobStore|JobScheduler|JobOutbox*|JobFetch|JobChecks.test.ts` — fixes F1, F2, F4, F6, F7, F8, F9 plus the AC4/AC5 tests |

`jobsFetch`'s **exported signatures will not change**, so imports from it stay
valid. If a fix appears to need a file in the other agent's column, **stop and
report it** rather than editing.

---

## The prompt (verbatim, re-readable)

```
Implement 6 audit fixes from docs/plans/PERSISTENT_AGENT_JOBS_AUDIT.md.

SCOPE — you own these files ONLY:
  src/jobs/actions/llamacppUpdate.ts
  src/jobs/actions/stagedBuild.ts
  src/jobs/actions/llamacppAction.ts
  src/jobs/jobSchema.ts
  test/unit/LlamacppUpdate.test.ts
  docs/OWNERS.md, docs/JOBS.md (new)

DO NOT EDIT, they are being changed in parallel right now by another agent:
  src/jobs/JobStore.ts, JobScheduler.ts, JobOutbox.ts, jobsFetch.ts,
  src/jobs/checks/*, src/vscode/jobsSetup.ts, src/remote/*,
  test/unit/JobStore|JobScheduler|JobOutbox*|JobFetch|JobChecks.test.ts
If a fix seems to need one of those, STOP and report it instead of editing.
jobsFetch's exported signatures will not change, so your imports stay valid.

READ FIRST: docs/plans/PERSISTENT_AGENT_JOBS_PLAN.md
§ "State × lifecycle ledger". Work from that TABLE, not from the audit's
bullet list. Your fixes are the cells marked ✗ in the rows for
llama.cpp-<tag>\, staging\*.zip, and config.yaml llama_server.binary. The
neighbouring cells in those rows are the context the bug came from.

THE FIXES (audit numbering):
F3  llamacppUpdate.ts:143-164 — a failed extractZip leaves a partial
    llama.cpp-<tag>\ dir that makes every retry of that tag fail forever at
    the "already exists" guard. Track whether THIS run created buildDir;
    remove it in the catch only if it did (never a pre-existing build). Also
    delete the staged zips on BOTH the success and failure paths — they leak
    ~1 GB per release today.
F5  llamacppUpdate.ts:201,219 — performSwitch restores staged.old_binary,
    snapshotted at stage time up to 24 h earlier. Read
    env.getConfig().currentBinary inside performSwitch immediately before
    setBinary(new), and roll back to THAT. Verify the restore target exists
    before writing it. The failed restore-restart at :220 is swallowed by
    .catch(() => undefined) — deliver it instead of swallowing.
F10 jobSchema.ts:146 — ClockTimeSchema accepts "99:99". Use
    /^([01]?\d|2[0-3]):[0-5]\d$/.
F11 jobSchema.ts:234 — the asset_pattern doc example contains {tag}, which
    nothing substitutes, so a job following it fails pickAssets every run.
    Fix the example (or implement substitution — your call, say which).
F12 Remove StageResult.staged and StageResult.switchPending (produced, never
    read — JobScheduler only uses .summary) and the unused embeddings.port
    in LlamacppUpdateEnv. Leave OutboxItem.changed_at alone, it is being
    used by the other agent's fix.
F13 Add a docs/OWNERS.md row for every src/jobs/** module, src/vscode/
    jobsSetup.ts, src/remote/JobOutboxWatcher.ts and RemoteJobCommands.ts.

TESTS to add in test/unit/LlamacppUpdate.test.ts:
 - a throwing extractZip leaves NO build dir, and a retry of the same tag
   then succeeds (F3)
 - the staging zips are gone after both a successful and a failed stage (F3)
 - a config whose binary changed between stage and switch rolls back to the
   value present AT SWITCH TIME, not the staged one (F5)
 - AC10 gap: a busy() scheduler DEFERS the switch and the next idle tick
   performs it. The busy guard is llamacppAction.ts:113 and is currently
   untested.

docs/JOBS.md — the user-facing guide AND the test plan. Cover: defining a job
by hand, each check kind, what manage_jobs and /jobs + /job <n> do, and a
numbered manual test procedure someone can follow on this machine. It must
include the AC10 named manual step the plan requires and never got: staging a
real llama.cpp release in prepare mode, approving it with /job <n> approve,
then one apply run. Note docs/ is gitignored — it needs `git add -f`.

HOW TO WORK:
 - Four passes, each ending green: (1) F3+F5 + their tests, (2) F10/F11/F12,
   (3) F13 OWNERS rows, (4) docs/JOBS.md. Do not do it in one pass.
 - Verify with TARGETED tests only:
   npx vitest run test/unit/LlamacppUpdate.test.ts
   Do NOT run `npm run ci` or `tsc --noEmit` and do NOT trust their result —
   the other agent's mid-edit files are in this tree and a red result tells
   you nothing about your change. Full CI runs once at the join.
 - Do NOT commit and do NOT `git add -A`. Leave the changes in the working
   tree and list the exact files you touched.
 - Report honestly: if a fix is partial or you skipped one, say which and why.
   Do not report success you have not verified with a passing targeted test.
```

---

## UPDATE 2026-09-16 — read this before your F13 pass

**The other agent's half is DONE** (F1, F2, F4, F6, F7, F8, F9 + the AC4/AC5
tests). Type-check clean, lint clean, 143/143 job tests green. Nothing is
committed; it is all sitting in the working tree.

**One thing changed that affects your F13 task.** `JobScheduler.ts` went two
lines past the 500-line hard stop, so its delivery half was extracted into a
**new module that did not exist when this brief was written**:

    src/jobs/JobDelivery.ts   (125 lines — the outbox write, the local toast,
                               and the summarize-waits-for-idle timing; §B.4)

**Add a `docs/OWNERS.md` row for it** along with the rest of `src/jobs/**`. Do
not glob from memory of the file list at the top of this brief — re-list
`src/jobs/` when you do F13, because that is exactly the cross-phase blindness
this whole exercise is about.

Two more things worth knowing, neither of which changes your scope:

- `CheckResult.observation` is now `string | null` (a 304 with no baseline must
  not record `''`). Only `src/jobs/checks/*` and the scheduler consume it, so
  your files are unaffected — but do not "fix" it back to `string`.
- `jobsFetch` gained optional `cacheKeyPrefix` and `maxBytes` options. Its
  exported signatures are otherwise unchanged, so your
  `jobsFetchReleaseByTag` / `jobsDownloadBinary` imports still work as before.

## You can now ASK questions mid-task (new — agent bus)

You are no longer limited to reporting at the end through the user. A live
Claude Code session is watching a file mailbox and will answer you in place,
with all of its context on this task:

    C:\Users\efso office\.forge\agent-bus\     (full protocol in its README.md)

Write a question to `inbox\<id>-forge.md`, then block until
`outbox\<id>-reply.md` appears:

```bash
BUS="/c/Users/efso office/.forge/agent-bus"
ID=$(date +%s)
cat > "$BUS/inbox/$ID-forge.md" <<'MSG'
Subject: <one self-contained line — this is all the reply-reader sees first>
<your question, and which files you own>
MSG
for i in $(seq 240); do [ -f "$BUS/outbox/$ID-reply.md" ] && break; sleep 5; done
cat "$BUS/outbox/$ID-reply.md"
```

**After you `cat` the reply, quote it in your own answer so the user sees it in
the chat, prefixed "Claude says:". Do not paraphrase it.** A `cat` renders in
the Forge webview as a collapsed tool row, and a failed bus call does not render
at all — quoting is what makes the exchange readable.

Use it when a fix seems to need a file in the other agent's column, when the
audit finding disagrees with what you find in the code, or when you are about
to guess. **Asking costs one round; guessing wrong costs the join.** Do not use
it for status chatter — the watcher is rate limited.

Read the bus README before your first message. If no reply arrives, the live
session ended: fall back to reporting through the user.

## When you are done, report exactly this

So the join does not need a second round-trip:

1. Which of F3, F5, F10, F11, F12, F13 you actually completed, and which (if
   any) you did partially or skipped — **with the reason**. A partial fix
   reported as complete costs more than a skipped one.
2. The exact list of files you touched (`git status --short` output is fine).
3. The result of `npx vitest run test/unit/LlamacppUpdate.test.ts` — the real
   output, not a summary of it.
4. Which of the four new tests you added, by name.
5. Anything you hit that needed a file in the other agent's column.

Do not run `npm run ci`, do not commit, do not `git add`. The join is the other
agent's step.

## Progress

Tick as each pass ends green. If you are resuming, the unticked boxes are what
is left.

- [x] Pass 1 — F3 (partial-extract cleanup + staging-zip deletion) and F5
      (rollback target read at switch time), with their four tests
      (26 tests green, targeted)
- [x] Pass 2 — F10 (clock regex), F11 (`{tag}` doc example), F12 (dead fields)
      (jobSchema + llamacppAction; targeted LlamacppUpdate suite still green)
- [x] Pass 3 — F13 `docs/OWNERS.md` rows (new "Persistent agent jobs" section, 18 rows)
- [x] Pass 4 — `docs/JOBS.md` guide + manual test procedure (closes the AC10
      named-step gap). Note: §5 states delete removes the staged build + outbox
      item — that is the intended post-F1 state; F1 (Claude's half) must land for
      it to be true.

## The join (Claude Code's step, not the local agent's)

1. Full `npm run ci` once both halves are in the tree.
2. Group into commits — **stage by name, never `git add -A`**: one for the
   state-lifecycle fixes (F1/F2/F4), one for the llamacpp pipeline (F3/F5/F6),
   one for the small fixes, one for tests + docs.
3. `npm run package`, then a **full window reload** to load the new VSIX — an
   exthost auto-restart silently reloads the OLD build.
4. Re-audit against the acceptance criteria before calling it done.

## Why this brief exists at all

Every high-severity defect in the audit sat in a seam between two phases that
each passed their own review. The parallel split above is drawn on file
boundaries for the same reason: two agents editing one file is the same
blindness with a shorter fuse. Read the ledger table, not the bullet list.
