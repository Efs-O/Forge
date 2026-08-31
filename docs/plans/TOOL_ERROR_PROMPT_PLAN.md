# Tool Error Messages as Prompts

**Status:** implemented 2026-08-31, then MEASURED AND LARGELY DISCONFIRMED — see "Outcome" at the end; §2 dropped during implementation (see Review pass and §2). All 13 acceptance criteria verified.
**Evidence:** audit of 9,607 deduped tool calls across 215 session logs in
`~/.forge/sessions/`. Method and headline numbers in
`project_forge_tool_audit` (memory) and CLAUDE.md's Agent-Ergonomics Traps.

---

## The thesis, and why it is not a guess

A tool's error string is the highest-leverage prompt in the system. It arrives
in the immediate context, at the instant the model is wrong, about the exact
call it just made. A `FORGE.md` line is 130 lines away, competing with every
other fact, and must be *retrieved* rather than read.

This is settled, not hypothesised. FORGE.md already states both of these:

> Process inspection: PowerShell `-Command` is policy-refused in this workspace.

> `exec_command` runs with NO shell — never wrap paths in quotes … no shell
> operators, no quoting ceremony — one plain string per arg.

Those lines were present for the whole logged period. The archive still holds
**17** `-Command is banned` failures and **12** "shell operators are not
permitted". The prose was there; it lost. Adding more of it is the one option
the data rules out.

The converse also shows up. `run_build` fails **5 times total**, and its error
says *"no package.json in … Pass cwd if …"*. It teaches, so it does not repeat.

---

## Scope

Verified by reading each call site and dating each failure. Four items in, four
out.

### IN

| # | Site | Failures | Latest | Why it is in |
|---|------|---------:|--------|--------------|
| 1 | `exec_command` | 119 | 08-31 | Error is a `JSON.stringify` blob — presentation only; the advice inside it was already correct |
| 2 | `read_file` + `list_directory` | 69 | 08-31 | Bare `ENOENT` passthrough; never names what the path resolved against |
| 3 | `commit` | 8 | 08-30 | "No staged changes to commit" names no alternative |
| 4 | `FORGE.md` | — | — | Contains a falsehood that would block this audit being redone |

### OUT — already fixed, verified by `git log`

- **`query_powershell`** (13 failures, last 08-28). `d4433fd` on **2026-08-28**
  added a message naming the workspace-relative path. Failures stop the same
  day. Nothing to do.
- **`edit_file` / `replace_in_file`** (46). `describeEditMiss` in
  `src/tools/editMatch.ts` already locates the nearest matching line and says
  "re-read that region with read_file and copy it verbatim". That is exactly
  the fix this plan would propose. It still fails occasionally (3 on 08-31),
  which supports the thesis rather than undermining it: the recovery is named,
  and exact-text reproduction remains genuinely hard for a small model. More
  prose will not move it.
- **`apply_line_edits`** (9, last 08-22) and **`replace_in_file`** (10, last
  08-16) — stale, both post-date the 0.12.47 fixes. No live signal.

### OUT — not prompt problems

`search_code` (12 of 13 are `spawn rg ENOENT` — ripgrep absent from PATH),
`web_fetch` (real 404/401/403), `run_tests` (spawn failures), `delete_file`
(EPERM on `.git` objects — a guard working correctly).

---

## Design

### 1. `ExecCommandError` stops serialising itself

`src/util/processSpawn.ts:30`

```ts
super(JSON.stringify({ kind, program, detail }));
```

This one line produces every blob in the archive. Replace with prose.

**Safe:** nothing parses the message. Every consumer
(`execTools.ts:219`, `videoExtract.ts:100,352`) reads `error.kind`, a real
property that is unchanged.

The message becomes `` `exec_command: ${detail}` `` where `detail` already
carries the specific cause. `kind` and `program` stay as properties for code;
they leave the string, where they were noise for the reader.

### 2. `exec_command` refusals name the substitute — **DROPPED, already done**

Implementation found this was written ten days before the failures it was meant
to prevent. `checkPowerShellBan` (`86276cf`, 2026-08-19) and
`checkShellOperators` (`405e150`, 2026-08-20) both already name the substitute
tools, in good prose. Pulling a real row out of the archive shows the model
received all of it:

```
Error: {"kind":"policy_refusal","program":"powershell","detail":"PowerShell flag
\"-Command\" is banned — a model-authored script cannot be checked by the
denylist, so it is never run. Use the dedicated tools instead: list_directory to
list files, read_file to read them, search_code to search, query_powershell for a
read-only workspace overview or a file hash, or exec_command with a real
executable and an args array."}
```

**This forces an honest correction to the plan's own headline.** I told the user
`exec_command` was "the biggest single win in the archive" because its errors did
not teach. They do teach. What §1 removes is presentation damage — 40 characters
of `kind`/`program` prefix before the sentence starts, escaped quotes, and the
shape of a data structure rather than an instruction. That is a real improvement
and worth the one-line change, but it is **not** a fix for 119 failures, and I
should not have promised one.

What remains unexplained: the model read correct, specific, actionable advice
and repeated the mistake ~40 times, most recently 11 times yesterday. That is
either a genuine capability limit, or a sign the advice arrives too late — at
failure time rather than in the schema. Both are hypotheses. Neither is
actionable without another measurement, and guessing between them is exactly
what this plan's own evidence standard forbids.

**Re-audit after §1 ships** is the honest next step: if the blob-to-prose change
moves the `-Command` and operator counts, presentation was the barrier; if it
does not, the barrier is elsewhere and no wording will move it.

### 3. `read_file` / `list_directory` name the resolution base

`builtinTools.ts:89` and `listDirectoryTool.ts:44` rethrow Node's raw message.
The model cannot see whether it guessed the path wrong or the *base* wrong —
and per CLAUDE.md, the workspace root is routinely not the project root, which
is exactly the shape of the logged paths (`n:\vs code apps\Ssuno\The Space You
Left\…`).

On `ENOENT` only, append: the path as resolved, the root it resolved against,
and "use `find_files` to locate it". Other errno values pass through unchanged
— `EISDIR`, `EACCES` and friends are already self-explanatory and inventing
advice for them would be guessing.

Both tools share the shape, so the helper lands in **one** owner file and is
imported by both. New row in `docs/OWNERS.md`.

### 4. `commit` names `stage`

`gitTools.ts:162`. Append: nothing is staged; call `stage` with the paths to
commit first, or check `git_status`.

### 5. FORGE.md — one correction, one deletion

**Correction (do regardless of the rest).** FORGE.md says:

> The `.forge/sessions/*.jsonl` and `.coordination/sessions/*` files are
> **decoys (stale/test data)**.

False, and expensively so: this audit read 9,607 real tool calls out of those
files. The claim is true only in its original narrow context — the *live
session title* is not in them. As written it tells a future agent to ignore the
best diagnostic data in the project. Rewrite to say what is actually true.

**Deletion.** Once §2 ships, the `-Command` bullet and the quoting half of the
`exec_command` bullet are paying rent on every turn for a lesson now delivered
at the point of use. Remove them. Keep the `wmic`/`taskkill` recipe (a genuine
workspace fact, not a tool rule) and keep the truncation-vs-quoting bullet
(it distinguishes two failures that look alike, which no single error can).

This is the part that makes the change net-negative in prompt tokens, which is
the point: guidance moves from a place that charges every turn to a place that
charges only the turns that need it.

---

## Non-goals

- No new tools, no schema changes, no guard loosened. Every refusal that fires
  today still fires; only its wording changes.
- No rewrite of `edit_file`'s matcher. Out of scope and already good.
- Not chasing `search_code`'s missing ripgrep — real, unrelated, environmental.

---

## Risks

1. **Tests asserting exact error text.** Expected; several exist. They are the
   verification, not an obstacle — each one that fails should be read to
   confirm the new text is *better*, then updated. A test that needs no thought
   to update was asserting the wrong thing.
2. **`kind` consumers.** Guarded by grep: three sites, all property reads.
   Re-grep after the edit.
3. **Longer errors cost context.** Each addition is one sentence on a path that
   currently wastes an entire round. A round is worth far more than a sentence.
4. **Unmeasurable until it runs.** These numbers come from real sessions; the
   fix cannot be proven by unit tests. Re-audit in a few weeks — the plan is
   falsifiable, and the audit script is reproducible from the memory note.

---

## Acceptance criteria

| # | Invariant | Verified by |
|---|-----------|-------------|
| 1 | No tool error reaching the model is JSON | Unit test: a `policy_refusal` message does not start with `{` and does not parse as JSON |
| 2 | `-Command` refusal names `query_powershell`, and reaches the model unwrapped | Unit test on the thrown `ExecCommandError.message` |
| 3 | Shell-operator refusal names the output options, unwrapped | Unit test on the thrown `ExecCommandError.message` |
| 4 | Builtin refusal still names its alternative | Existing behaviour — assert it did not regress |
| 5 | `ExecCommandError.kind` unchanged for all four kinds | Unit test asserting `kind` after each guard throws |
| 6 | `read_file` ENOENT names resolved path + base + `find_files` | Unit test |
| 7 | `list_directory` ENOENT does the same | Unit test |
| 8 | Non-ENOENT file errors pass through unchanged | Unit test with `EISDIR` |
| 9 | `commit` with nothing staged names `stage` | Unit test |
| 10 | FORGE.md no longer calls the session logs decoys | Manual read |
| 11 | FORGE.md is shorter than it was | `wc -l` before/after |
| 12 | Full gate green | `npm run ci` and `npm run package` |
| 13 | `run_terminal` refusal wording unchanged | Unit test |

---

## Review pass (before implementation)

Four checks against the plan's own assumptions. All four held; two widened the
expected benefit, one narrowed the risk.

- **R1 — is there a parser downstream of the message?** No.
  `ToolDispatch.ts:355` is the single funnel (`` `Error: ${err.message}` ``) and
  it does no parsing. §1 fixes the blob at its source with nothing to migrate.
- **R2 — do the guards cover every blob?** No, and that is good news. Six
  `ExecCommandErrorKind`s exist, and `timeout`, `cancelled` and `spawn_error`
  serialise too. §1 therefore also fixes the 17 opaque
  `Error: {...}` rows the audit could not classify, plus the 3 `run_tests`
  `spawn C:\Progra…` blobs — which were counted against `run_tests`, not
  `exec_command`. The blast radius of one line is larger than the plan said.
- **R3 — does `run_terminal` share the error type?** No. It throws a plain
  `Error` with its own denylist wording (`execTools.ts:62`). Unaffected; drop
  it from the risk list. Added as acceptance #13 anyway, because "unaffected"
  is worth an assertion rather than a memory.
- **R4 — ordering.** The FORGE.md *correction* (§5, first half) is independent
  of everything else and fixes an active falsehood, so it moves to step 1. The
  *deletion* still has to wait for §2 to ship the lesson it removes.

One scope note the review did not change but should be said plainly: `edit_file`
was in my verbal recommendation to the user and is **out** after reading
`describeEditMiss`. It already does what this plan would have added. Fixing it
again would have been busywork justified by a stale number.

---

## Order

1. FORGE.md correction (§5 first half) — independent, fixes a live falsehood.
2. `ExecCommandError` message (§1) — largest win, smallest diff.
4. Shared ENOENT helper + both call sites (§3), `docs/OWNERS.md` row.
5. `commit` (§4).
6. FORGE.md deletion (§5 second half).
7. Tests for all thirteen criteria; `npm run ci`; `npm run package`.

---

## Outcome: measured against the live model, 2026-08-31

Two independent measurements, both after implementation. Both say the premise
was wrong.

**1. A/B against the running Qwen3.8-27B** (llama-server on :8080, n=14 per
arm, same seeds, identical conversation, only the tool-result text differing):

| next action after the refusal | OLD (JSON blob) | NEW (prose) |
|---|---:|---:|
| retried `powershell` | 0 | 0 |
| moved to a working tool | 8 | 9 |
| answered in text | 6 | 5 |

No difference worth the name, and **zero retries in either arm**. Presentation
was not the barrier.

**2. What actually followed each failure in the archive** — the check that
should have come before any of this work:

| error | occurrences | recovered on the very next call |
|---|---:|---:|
| `commit` nothing staged | 6 | **100%** (4 went straight to `stage`) |
| `exec_command` shell operators | 14 | **100%** |
| `-Command` refusal | 24 | 92% (2 retries) |
| `list_directory` ENOENT | 21 | 81% |
| `read_file` ENOENT | 48 | 77% |

The model was never trapped. It reached for `stage` unprompted in the exact
case where this plan added text telling it to reach for `stage`.

### What this costs the plan

The headline was wrong twice, in the same direction, and I should name both.
First I called `exec_command` "the biggest single win in the archive" when its
advice was already correct (caught during implementation). Then I kept the
framing that these failures were *wasted rounds*. They are not. They cost one
round each, and the agent recovers from ~85% of them immediately. Across 9,607
calls that is roughly 2.6% of rounds spent on recoverable misses — which is
what exploration costs, not a defect.

**The correct metric was never the failure rate. It is the recovery rate.** A
tool with a 10% failure rate that always recovers is healthy. A tool with a
2% failure rate the model cannot recover from is broken. `ask_user` was the
second kind, which is why fixing it mattered: it returned `(cancelled)`, a
*plausible* answer, so there was nothing to recover from — the model believed
the user had declined and stopped. Nothing else found in this investigation is
that shape.

### What stays

The shipped changes are kept, on much weaker grounds than they were made:
prose beats JSON for anyone reading a log, and naming the resolution base helps
the ~20% of ENOENTs that do not recover immediately. All 13 acceptance criteria
still hold. But the expected benefit is *marginal*, not the headline win the
plan opened with, and no further work in this direction is justified.

### The rule worth keeping

Before changing a tool because its failure rate looks bad, measure what the
agent did on the **next** call. If it recovered, the rate is exploration cost
and the tool is fine.
