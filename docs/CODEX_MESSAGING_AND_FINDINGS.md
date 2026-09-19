# Codex messaging issue + CODEX_EVAL findings — working notes

Date: 2026-09-19. Branch `feat/business-messaging` @ `65d56df` (BM-1..9b committed).
Purpose: record (a) why Forge could not reach the live Codex session via the normal tool, and the
working channel that was used instead, and (b) the independent review findings Codex produced, with
the fix plan being applied in full auto. Keep this for follow-up investigation / finetuning.

## Part A — The "messaging Codex" issue

### Symptom
`ask_live_session(target: "codex", ...)` failed every attempt with:

```
Could not deliver to Codex, so the question was NOT sent:
spawn C:\Users\efso office\AppData\Roaming\npm\codex ENOENT
```

The tool refused to fall back to `ask_local_agent` (correctly — that starts a fresh, empty session
that does not know this work).

### Root cause (diagnosed, not yet fixed in Forge)
- The `codex` model in `N:/vs code apps/Forge/.forge/config.yaml` points at the real binary:
  `...\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`.
  That path is used for **delegation** (`ask_local_agent` / `codex exec`), which is fine.
- But the **live-session** door (`ask_live_session` → `src/tools/liveSessionTool.ts` →
  `src/agentBus/codexDelivery.ts`) runs `codex queue --thread <id> --message <text>`. On this Windows
  host it resolves `codex` to the npm global shim `C:\Users\efso office\AppData\Roaming\npm\codex` —
  an **extensionless Unix shell script** (421 bytes), not a Windows executable. Node's `spawn` cannot
  execute it directly → `ENOENT`. The runnable entry points are `codex.cmd` / `codex.ps1` /
  `node_modules\@openai\codex\bin\codex.js`.
- So the tool is spawning the wrong artifact: it needs either the `.cmd` shim, `node codex.js`, or the
  vendored `codex.exe` — not the bare extensionless shim.

### What actually worked (used this session)
The documented agent-bus door, driven directly from Git Bash:

```
node "C:/Users/efso office/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js" \
  queue --thread 01a0a9a1-2e7b-7713-af2f-d6cb159bf510 --message "<text>"
```

- `--thread` is the configured `agent_bus.codex_thread` UUID (in `N:/vs code apps/Forge/.forge/config.yaml`).
- The live session title is **"monitor halluscribe  speeds"** (note: two spaces between "halluscribe"
  and "speeds"). `codex queue --thread "monitor halluscribe speeds"` (one space) does NOT match — the
  thread must be addressed by its UUID, or by the exact two-space title.
- Delivery confirmed: `Queued message 01a0b868-3622-7c40-92ca-fc6a3712b92f for thread 01a0a9a1-...`.
- Codex replies through `/agent/reply` or the outbox (`~/.forge/agent-bus/`), per the agent-bus README.

### Open items to investigate / finetune (after the impl fixes)
1. **Fix the spawn target** in `codexDelivery.ts` (or wherever it builds the `codex` command): on
   Windows use the `.cmd` shim or `node <pkg>/bin/codex.js`, not the extensionless shim. Confirm the
   exact code path and whether it should reuse the `codex.exe` path already in `config.yaml`.
2. **Thread addressing**: `ask_live_session` for Codex should resolve the session by the configured
   `codex_thread` UUID (it does), but the human-facing title has a double space — worth confirming the
   tool never falls back to a fuzzy title match that would silently no-op.
3. **Delivery verification**: `codex queue` returns fast and only *queues*; it does not confirm the
   session is alive or that the message will be processed. There is no read-back of "session N is open
   and idle". Consider a lightweight liveness check (e.g. `codex` thread status) before declaring
   delivery.
4. **No read channel from Forge**: Forge can *send* to the live Codex session but the reply path is
   outbox/HTTP, not a blocking read. For a "report for verification" flow, Forge must poll the outbox
   or wait for the user to relay. Decide the intended pattern.

## Part B — CODEX_EVAL findings (independent review) and fix plan

Source: `docs/internal/briefs/CODEX_EVAL.report.md` (written by the live Codex session, one-shot
second reviewer). Verdict: **NO-GO until findings 1–3 are fixed (or explicitly accepted), and D10 is
decided.** Privacy review: clean (no message text/names/numbers in logs or tests). File sizes under
the 500 hard ceiling but near it.

### Fix status (applied this session, pre-gate)
- **Finding 1 — FIXED.** All three `load_contact_book` (apple_messages / whatsapp / viber) now check
  `handle.resolve(HOME_DOMAIN, ADDRESS_BOOK).is_none()` first: absent → empty book (D7, not an
  error); present-but-copy-fails → `ReaderError::Database(...)` so the import reports the failure
  instead of silently returning an empty book. The existing doc comment ("a file that exists but
  cannot be opened is a real error") is now actually enforced.
- **Finding 2 — FIXED.** `scan_whatsapp` and `scan_viber` no longer collapse `Err(_)` into "no
  targets". `Ok(false)` (absent) → no target; `Err(e)` → `eprintln!("scanner: <provider> discovery
  failed: {e}")` (count-only, no message content) then no target. The read path still surfaces the
  same error per-target, so this is a preview diagnostic, not a second error surface.
- **Finding 3 — FIXED.** The `onToggle` status re-fetch `.catch` in
  `BusinessMessagesSettings.svelte` now sets `workspaceError` ("Could not refresh the owner profile
  status … the note below may be out of date") instead of silently swallowing the failure. The
  `loadProfileUi` catch already surfaced it.
- **Finding 4 — DOCUMENTED / DEFERRED (accepted limitation).** `read_profile_md` returns
  `Option<String>` and maps every read error (missing *or* unreadable/corrupt) to `None`, which
  Phase 9b turns into `OwnerProfileNotFound`. Distinguishing "unreadable" needs a 4th `ChatProfile`
  state + a richer `read_profile_md` return type that ripples into `types.ts`/Svelte — and
  `profile/mod.rs` is at exactly 500 LOC (the hard ceiling), so it cannot be done without a
  restructure. It is Low/med, privacy-safe (the profile is simply omitted), and NOT in the NO-GO
  gate. Recommendation: leave as-is for this phase; if the user wants a distinct "owner profile
  unreadable" status, that is a small follow-up (add `OwnerProfileUnreadable` state + return an
  `enum`/`Result` from `read_profile_md`, surface in the settings note).
- **Finding 5 — NO CHANGE (plan-mandated heuristic).** Viber group-ness from distinct incoming
  sender phones, not `ZGROUPID`, is what the plan requests. Kept.

| # | Sev | File:line | Problem | Fix being applied |
|---|-----|-----------|---------|-------------------|
| 1 | **High** | `readers/apple_messages.rs:171-173`, `readers/whatsapp.rs:217-219`, `readers/viber.rs:171-173` | `load_contact_book` calls `handle.copy_to_temp(HOME_DOMAIN, ADDRESS_BOOK).ok()`. `copy_to_temp` returns the **same** `BackupError::Io` for "file genuinely absent" and for a real copy/I-O failure. So an unreadable/damaged `AddressBook.sqlitedb` (permissions, corrupt hashed file) is silently treated as "no address book" → empty contact book, unresolved handles, and a sweep that *succeeds* with misleading output. Violates the no-silent-error rule. | Distinguish the two: only return an empty book when the file does **not resolve** (`handle.resolve(...)` is `None`). If it resolves but the copy fails, surface `ReaderError::Database(...)` so the import reports the failure instead of pretending success. Apply to all 3 readers. |
| 2 | **Medium** | `scanner/mod.rs:421-423`, `:450-452` | Provider discovery turns WhatsApp/Viber open errors into "no targets" (`.ok()` / `Err => none`). A provider-specific open failure is invisible; the user may see an apparently clean import with that provider silently absent. | Preserve and surface the error (or return a diagnostic) rather than treating every `Err` as "not present". |
| 3 | **Medium** | `components/settings/BusinessMessagesSettings.svelte:82-87` | After a successful toggle save, the `business_profile_status` re-fetch `.catch` does nothing → the owner-profile warning can stay stale and the user is not told the status could not be checked. Conflicts with the report's claim that status-fetch failures are surfaced. | Surface the failure (note / error state) instead of swallowing it. |
| 4 | **Low/med** | `profile/writer.rs:74-75` + `profile/mod.rs:92-104` | `read_profile_md` returns `None` for **every** read error (missing *or* unreadable/corrupt); Phase 9b maps that to `OwnerProfileNotFound`. A permissions/corruption problem is presented as "no profile" — safe for privacy, but not diagnostically honest. | **Assess, likely defer:** the resolver is a pure `Option<String>` by design and the settings note is the minimal surface. Distinguishing "unreadable" needs a richer return type (an error variant) that ripples into the consumer. Recommend documenting as a known limitation unless the user wants a distinct "owner profile unreadable" status. |
| 5 | Known limitation | `readers/viber_db.rs` | Viber group-ness is inferred from distinct incoming sender phones, not `ZGROUPID` (as the plan requests). A group with one visible incoming sender (or missing sender rows) can look 1:1. | **Keep as documented heuristic** (plan-mandated). No code change; note it in the report. |

### Deferred items (from the reports) — recommendation
- **BM-8 D10 "summary pending": DEFER.** No raw-only index/backfill mechanism exists; the current
  conflict path defers the whole session. Needs the user's explicit semantics decision first. (Not a
  code defect; out of scope for these fixes.)
- **BM-9b `OwnerProfileNotFound` in-chat vs settings-only: DEFER.** The settings note is the minimal
  non-invented surface; do not add a chat surface without a product decision.

### Out of scope for this fix pass
- D10 (needs a product decision).
- Finding 5 (plan-mandated heuristic).
- Finding 4 (assess + likely document, not restructure) — unless the user wants the richer error type.
