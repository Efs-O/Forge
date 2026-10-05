# Control server `GET /stats` — plan

Written 2026-10-05. Implementer: Codex (luna6, high), in a Forge worktree with `CLAUDE.md` copied in. Supervisor:
Claude. Consumer: the local-only Forge card on Strata's Monitor tab
(`docs/local/strata-monitor-pr/PLAN.md`, Phase 5). Any other local dashboard can use it too.

## Why

The user wants a Forge card on Strata's Monitor page: turns, compactions, tool health, tokens. Strata must not parse
Forge's session logs or `config.yaml`. CLAUDE.md: external consumers extend the control server API, and that API is
the compat contract. So Forge exposes the numbers itself.

## What

`GET /stats` on `ControlServer` (`src/backend/ControlServer.ts`), next to `/healthz` and `/models`: loopback only,
no token, as those are. It returns **counts only**: no prompt, answer, tool argument, file path or summary text,
ever. Shape (Zod schema in the new module, exported for tests):

```json
{
  "forge_version": "0.16.87",
  "day": "2026-10-05",
  "today": {
    "turns": 41,
    "requests": 512,
    "compactions": 2,
    "compaction_attempts_failed": 1,
    "compactions_suppressed": 4,
    "tool_calls": 486,
    "tool_failures": 23,
    "input_tokens": 9120345,
    "output_tokens": 88213,
    "turn_errors": 0
  },
  "last_request": {"model": "strata-flashnext-iq3s", "input_tokens": 70241, "context_limit": 200000, "at": 1791182458},
  "computed_at": 1791182500
}
```

- **Source:** today's session logs under `~/.forge/sessions/`, the files whose mtime falls on the local calendar
  day. They are the forensic record and cover every Forge window, not just the one serving the port.
- **Counting rules:**
  - `turns` = `user` rows;
  - `requests`, `input_tokens`, `output_tokens` = the delta of each `usage` row from the previous `usage` row in the
    same file (any day; 0 before the first). `usage` rows are session-to-date totals (`SessionUsage`), not
    per-request counts — summing them read 74.9 billion input tokens on 2026-10-05. A total that goes backwards
    restarted, so its own value is the delta. `last_request.input_tokens` is the input delta of the newest row
    whose `model_request_count` delta is exactly 1; a multi-request flush is a sum, not one prompt's size;
  - `compactions` = `compaction` rows;
  - `compaction_attempts_failed` = `compaction_attempt` rows with `phase: "finished"` and an `outcome` other than
    `"compacted"` (verified against real logs 2026-10-05: attempts carry `attempt_id` + `phase`
    `start`/`finished`/`suppressed`, not a generation; today's logs held 9 `compacted`, 8 `failed`, 55 `suppressed`).
    `suppressed` rows (a compaction that was never tried, e.g. a budget refusal) are reported separately as
    `compactions_suppressed`, not as failures;
  - `tool_calls` = `tool` rows;
  - `tool_failures` = tool rows whose result is a failure;
  - `turn_errors` = `turn_error` rows.
  Rows are counted only when their `timestamp_ms` (or the cursor-derived position) falls on today.
- **Tool failure classification:** `isFailureResult(content)` from `src/sidebar/toolResultView.ts`, the same
  function `ToolDispatch` uses (phase 1 finding). Persisted `tool` rows carry the result text in `content`. Never a
  new regex.
- **Deduplication:** `readSessionLogRows` in `src/sessions/sessionLogRows.ts` (extracted in phase 1 from
  `ArchivedSessions`).
- **`context_limit`:** from the resolved model's per-slot context, via `perSlotContext()` in
  `src/util/contextBudget.ts`. Never raw `num_ctx`. `null` when the model is not in the catalog.
- **Cost control:** in-memory cache per file keyed by `(size, mtimeMs)`. An unchanged file is not re-read, and a
  grown file is re-read in full (files are a few MB; incremental parsing is not worth its bugs). The whole reply is
  cached for 3 s. `computed_at` says when it was built.
- **Errors:** an unreadable file is skipped and counted in `"skipped_files"`. The endpoint never throws a 500
  because of one bad log. A missing sessions directory → zeros.

## Phases

1. Extract the session-log row reader from `ArchivedSessions` (no behaviour change; existing tests stay green),
   and the tool-failure classifier if needed.
2. `src/backend/controlStats.ts`: computes the reply from a sessions directory and a clock (both injected, for tests).
3. Wire `GET /stats` in `ControlServer.ts`, update the route list in its header comment, and update `docs/OWNERS.md`.

Each phase: `npm run ci` green, one commit, stop for review.

## Phase 4 — the active conversation (added 2026-10-05)

User review of the Strata card: "it should report the active session — I don't understand why it has to include
the stats from all the sessions". The day-wide totals mix every chat, window and model, and say nothing about the
chat the user is looking at. So `/stats` gains a `session` block, and the Strata card shows that instead.

```json
"session": {
  "conversation_id": "3507ac0c-513e-4934-ab5c-37b7b7743741",
  "turns": 12, "requests": 140, "compactions": 1, "compaction_attempts_failed": 0, "compactions_suppressed": 2,
  "tool_calls": 131, "tool_failures": 4, "input_tokens": 3120345, "output_tokens": 21877, "turn_errors": 0,
  "started_at": 1791100000,
  "last_request": {"model": "strata-flashnext-iq3s", "input_tokens": 33372, "context_limit": 200000, "at": 1791231105}
}
```

- **Which conversation:** the sidebar's `activeConversationId` in the window that owns the control server port
  (that window's `SidebarProvider`). `ControlServerDeps` gains `activeConversationId?: () => string | undefined`,
  wired in `extension.ts`; absent ⇒ `session: null`. A second Forge window cannot bind the port, so its chat is not
  the "active" one. That limitation is accepted; document it in the route comment.
- **Which file:** `SessionLogger` names the log `<conversation id>.jsonl` in `sessionsDirectory()`. The id must match
  `^[A-Za-z0-9_-]+$` before it is joined to a path; anything else ⇒ `session: null`. A missing file (a new chat
  with nothing logged yet) ⇒ the block with zero counts, `started_at: null`, `last_request: null`.
- **Counts:** the same rules as `today`, over the **whole file**, every day, deduplicated by the same reader. Usage
  deltas start from 0 at the top of the file, so the session's token totals are the sum of its deltas.
  `started_at` = the first row's `timestamp_ms` / 1000. `session.last_request` is the newest single-request usage
  row **in this file**. The top-level `last_request` stays as it is, for compatibility.
- **Counts only, still:** no title, no text. The id is already a filename, not user content.
- **Cache:** the active file goes through the same per-file `(size, mtimeMs)` cache. The day-rollover eviction must
  keep the active file even when it was last written on an earlier day. The whole-reply cache key gains the
  active id, so switching chats is reflected at once, not after 3 s.
- **`today` stays** in the reply (it is the compat contract now). Only the Strata card stops showing it.

Strata side (local branch `local/cpu-sensors`, never pushed): the Forge card renders `forge.session`, labelled
"this chat". `session: null` ⇒ "No active Forge chat". The day totals disappear from the card.

Phase 4 is one commit: builder + route deps + `extension.ts` wiring + tests, `npm run ci` green, then stop for
review. The Strata card change is a second commit on the Strata branch.

## State × lifecycle ledger

No durable state: the endpoint only reads session logs that `SessionLogger` already owns, and its caches live in
memory.

| Artifact | Create | Delete | Pause / disable | Crash mid-write | Owner-process death | TTL / expiry |
|---|---|---|---|---|---|---|
| Per-file parse cache (memory) | first `/stats` that reads the file | window/extension host exit | n/a, no setting; no callers → never built | a torn last line is skipped by the shared reader | gone with the process; rebuilt on demand | entry replaced when `(size, mtimeMs)` changes; entries for files not from today dropped on each build |
| Whole-reply cache (memory) | each build | process exit | n/a | n/a, built then swapped in one assignment | gone with the process | 3 s |

| Active-session file entry in the per-file cache (memory, phase 4) | first `/stats` while that chat is active | when another chat becomes active and the file is not from today | `activeConversationId` dep absent ⇒ never created | torn last line skipped by the shared reader | gone with the process | replaced when `(size, mtimeMs)` changes |

CI-enforceable row: the per-file cache must drop entries for files that are not from today, or it grows without
bound over a long-running window. Test: build on day 1 with 3 files, advance the injected clock to day 2, build →
the cache holds only day-2 files. Phase 4 extends it: with an active chat whose file is from day 1, the day-2 cache
holds the day-2 files plus that one file, and nothing else.

## Acceptance criteria

- `npm run ci` green after each phase; `ArchivedSessions` tests unchanged and green after phase 1.
- Unit tests with a temp sessions dir:
  - every count is correct on a hand-written log;
  - a replayed (duplicated) log counts once;
  - a torn last line is skipped;
  - yesterday's rows in today's file are not counted;
  - a missing dir → zeros;
  - the day-rollover cache test from the ledger passes.
- A content-leak test: a log whose rows carry distinctive strings in content/summary/arguments → none of them appears
  in the serialized reply.
- Live: `curl http://127.0.0.1:8799/stats` against the user's running Forge returns plausible numbers. The
  supervisor cross-checks them once by hand against today's logs.
- No new dependency, no outbound traffic, loopback bind unchanged.
- Phase 4 tests:
  - the active file's counts span every day in it, not just today;
  - switching the active id changes `session` on the next call, inside the 3 s reply cache;
  - an id with `/`, `\` or `..` ⇒ `session: null`, and no file outside the sessions dir is opened;
  - no dep or no active id ⇒ `session: null`; active id with no file ⇒ zero counts;
  - `session.last_request` comes from the active file even when another file has a newer request;
  - the content-leak test also covers `session`.
- Phase 4 live check: switch chats in the sidebar, then `curl :8799/stats`. `session.conversation_id` follows, and
  the supervisor cross-checks the turn count against that chat's log.
