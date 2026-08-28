# Token efficiency — measured waste in the agent loop (impl plan)

**Goal:** cut the tokens a turn spends without the model ever seeing less than
it does today. Every change here is either *free* (the same information, fewer
tokens) or a *quality improvement that happens to save tokens*. Nothing in this
plan trades accuracy for cost — that class of change is listed in §5 as
benchmark-gated, deliberately not implemented.

**Scope discipline:** two code changes and a doc. One new ~70 LOC module, one
capped snippet builder, one wiring line in the existing `prepareMessages`
pipeline. No new config surface, no change to `toolResultContext`'s
fit-only excerpting, no proactive context dropping.

---

## 1. The measurement (2026-08-28)

Analyzer run over `~/.forge/sessions/` — 197 session logs, 2,351 turns,
12,447 tool calls. Token figures use Forge's own measured `CHARS_PER_TOKEN =
3.1`.

| | |
| --- | --- |
| Unique content produced | 16.0 M tokens |
| Actually sent to the model | 130.0 M tokens |
| **Amplification** | **8.14×** |
| Rounds/turn | median 1, p90 12, max 64 |

**Caveat on the absolutes:** 89 of the 197 files share an opening user message.
Resumed sessions re-persist prior history, so the M-token totals are inflated
by duplication. The *ratios* and the *per-tool ranking* are what this plan acts
on; both are unaffected by duplicate whole-session copies.

Amplification is the entire story. A tool result produced at round 3 is
re-tokenized at rounds 4…N, so the number that matters is not result size but
**size × rounds survived**:

| tool | calls | raw kTok | **resend kTok** | avg tok | max tok |
| --- | ---: | ---: | ---: | ---: | ---: |
| `read_file` | 3,514 | 6,057 | **68,024** | 1,724 | 23,969 |
| `search_code` | 1,170 | 5,146 | **16,804** | 4,398 | **542,853** |
| `git_diff` | 119 | 274 | 3,152 | 2,306 | 38,400 |
| `exec_command` | 1,366 | 378 | 2,788 | 277 | 3,776 |
| `web_fetch` | 114 | 295 | 1,486 | 2,584 | 38,723 |

**Top 3 tools = 91% of the entire tool-result token bill.** Everything below
`git_diff` is rounding error: `edit_file` (1,458 calls) averages 24 tokens of
result, `write_file` 25, `list_directory` 113. Those tool shapes are already
right and are not touched.

Reproduce with `scripts/analyze-session-tokens.py` (added by this plan).

---

## 2. Fix 1 — `search_code` has no character cap

**Finding.** `makeSearchCodeTool` bounds output by *files* (`max_results`,
default 20), by *snippets per file* (`SNIPPETS_PER_FILE_LIMIT = 8`), and by
*output lines* (`OUTPUT_LINE_LIMIT = 50`). Nothing bounds **line length**, and
ripgrep's notion of a line is the file's. Single-line JSON therefore defeats
every existing limit at once:

```
"query": "qwen", "include": "**/*.json"
  -> Elysium/Elysium_Rebuild_V1/video/ltx25/object_info.json
     one line, ~1.7 MB  =  542,853 tokens in a single tool result
```

**11 calls out of 1,170 account for 96% of all `search_code` bytes.** This is
almost certainly the origin of the `exceed_context_size_error` recorded in
`tool-result-context-ab-results/report.json` (176,446 tokens into a 62,208
window).

**Why this is free.** A 1.7 MB single line carries no information the model can
act on — it cannot be read, quoted, or edited from a search result, and it
evicts everything that *was* useful. Bounding it cannot lose signal that was
ever recoverable.

**Change** (`src/tools/dirTools.ts`):

- `MAX_SNIPPET_CHARS = 400` — per emitted snippet line.
- For a `match` event, centre the kept window on the first submatch
  (`data.submatches[0].start`) so the term the model searched for is always
  inside the window; for a `context` event, keep the head.
- Elide with `… +N chars`, so the model can see the line was cut and how badly.
- `MAX_TOTAL_RESULT_CHARS = 60_000` on the joined output, appended with the
  existing `capResultText` (from `src/tools/resultCap.ts`, the canonical owner)
  so the truncation notice and its `advice` wording stay consistent with the
  MCP bridge and `read_file`.

`OUTPUT_LINE_LIMIT`, `SNIPPETS_PER_FILE_LIMIT` and `max_results` are unchanged
— they already do their job for normal source files.

---

## 3. Fix 2 — superseded `read_file` results stay in context verbatim

**Finding.** `read_file` is 70% of the resend bill. Its median result is a
perfectly reasonable 1,032 tokens, so individual calls are not the problem —
**retention** is. A file read at round 2 is re-sent verbatim for every
remaining round of the turn, including after the agent has read it again.

- 507 of 3,514 reads (**14.4%**) re-read a path already read in the same turn.
- The superseded copies are ~0.68 M tokens *before* the resend multiplier.

**Why this is a quality fix first.** When the same path appears twice with
different content, the model is shown two versions of one file with nothing
saying which is current. After an `edit_file`, the stale copy is not merely
expensive — it is wrong, and it is the copy the model read first.

**The safety rule (this is the whole design).** Replace an earlier `read_file`
result **only when a strictly later, complete `read_file` result for the same
path exists in the same model-facing message array.** In that case the
authoritative content is provably still present, so nothing is lost.

Explicitly **not** superseded:

- A read whose file was later edited but **not** re-read. The content is stale,
  but it is the only copy the model has; dropping it destroys information.
  This is the tempting extra 30% and it is a quality regression — it stays out.
- Reads that returned an error or a truncation marker (they are not a complete
  copy of anything, and the marker text is what tells the model to retry).
- Anything that is not `read_file`.

**New module: `src/agent/staleReadSupersede.ts` (~70 LOC).**

`supersedeStaleReads(messages: ChatMessage[]): ChatMessage[]`

1. Walk assistant messages, building `tool_call_id -> {name, arguments}` from
   `tool_calls`. Pairing is by **id**, never positionally — the in-memory
   `ChatMessage` always carries `tool_call_id` on tool rows (see the truncation
   path in `ToolCallingLoop`), so the exact mapping is available here. (The
   *session log* lacks tool names, which is why the offline analyzer has to
   pair positionally; that constraint does not apply in-process.)
2. For each `role: 'tool'` row whose call is `read_file`, parse `arguments` and
   key on the normalized `path` argument. A malformed `arguments` JSON, or a
   missing `path`, disqualifies the row — no key, no supersede.
3. Keep the **last** index per path. Replace every earlier one's `content` with:

   ```
   [Forge: superseded — this file was read again later in this conversation.
    The current contents of <path> are in that later result.]
   ```

4. Return a new array; never mutate the input. Rows without a replacement are
   passed through by reference.

**Wiring** (`src/sidebar/ModelTurn.ts`, inside the existing `prepareMessages`):

```ts
return prepareToolResultContext({
  messages: supersedeStaleReads(withPlan(injected, conv.plan)),
  ...
}).messages;
```

`prepareMessages` is the correct seam and the only one used: it already
receives a copy, already runs once per round, and is already documented as
model-facing only. `conv.messages` — the sidebar transcript, the persisted
JSONL, and the exact bytes `read_tool_result` recovers — is untouched, which is
what keeps this reversible and auditable.

Ordering matters: supersede runs **before** `prepareToolResultContext`, so the
freed budget is counted by `computeContextBudget` and the fit-only excerpting
has less work to do. On a turn that previously did not fit, this can mean the
surviving results are excerpted *less* aggressively — a second quality win.

---

## 4. Not doing: prompt-cache headers

Raised during investigation, then narrowed on inspection. There is no
`cache_control` anywhere in `src/`. But Forge's cloud providers are
OpenAI-compatible (`xai`, `openrouter`, `openai`, `openai-compatible`), and
prefix caching on those is automatic and server-side — there is no header for
Forge to send. The actionable version of this concern is **prefix stability**
(does anything near the front of the prompt churn per round?), which is a
measurement, not a change, and is not in this plan's scope.

---

## 5. Benchmark-gated — deliberately not implemented

These *do* trade information for tokens. None should land without a replay
harness over 5–10 recorded turns from `~/.forge/sessions/` reporting **task
success rate alongside token count**, because the failure mode is invisible:
the agent does not report that it guessed.

- Gating the tool-schema array by task phase.
- Summarizing (rather than pointer-replacing) old tool results.
- Dropping `exec_command` output below a size threshold.
- Lowering `MAX_READ_FILE_CHARS` (120,000) or `DEFAULT_MAX_RESULT_CHARS` (24,000).

A saving that costs one extra turn of rework is a net loss: the retry pays the
full amplified prompt again.

---

## 6. Verification

- Unit tests for `supersedeStaleReads`: last-read-wins; single read untouched;
  different paths independent; error/truncated results excluded; malformed
  `arguments` excluded; input array not mutated.
- Unit tests for snippet capping: long line elided and centred on the submatch;
  short line byte-identical to today; total cap applied.
- `npm run ci` (type-check, lint, tests, production build).
- Re-run `scripts/analyze-session-tokens.py` after a few live turns and confirm
  the `search_code` max drops out of the six figures.

**Owners** — add to `docs/OWNERS.md`:

| Superseded read-result elision (model-facing) | `src/agent/staleReadSupersede.ts` |

---

## 7. Measuring the result

### 7.1 Why "run 10 sessions and compare" does not work on its own

Aggregate amplification is dominated by **task mix**, not by the code. Proof,
from the baseline itself — the 10 most recently modified sessions, all of them
*pre-fix*:

```
$ python scripts/analyze-session-tokens.py --newest 10
AMPLIFICATION       : 3.68 x        (all 197 sessions: 8.14 x)
rounds/turn         : median 4  p90 11  max 36
```

Same code, same tools, **half the amplification** — because those turns did
different work. A post-fix cohort of 10 could just as easily read *worse* than
the baseline while the fixes were working perfectly. On this metric, at this
sample size, a before/after of different sessions measures the tasks, not the
change.

### 7.2 What to use instead: the counterfactual

The session logs preserve **raw** tool results (excerpting happens on the
model-facing copy only, never on `conv.messages`). So each recorded turn can be
re-scored under both rule sets and diffed against itself. No task-mix confound,
because it is the same turn on both sides:

```
$ python scripts/analyze-session-tokens.py --counterfactual
```

Measured over the full 197-session baseline:

| | before kTok | after kTok | saved |
| --- | ---: | ---: | ---: |
| `search_code` cap | 16,803.6 | 1,934.6 | **88.5%** |
| superseded `read_file` | 67,975.2 | 55,396.6 | **18.5%** |
| **combined** | **84,778.8** | **57,331.2** | **32.4%** |

Largest single `search_code` result: **542,853 → 3,542 tokens.**

Those two tools are 87% of the whole tool-result bill, so 32.4% of them is
**~28% off the total resend cost** — with the model seeing the same information
it saw before, plus a correct answer to "which copy of this file is current".

The `search_code` figure is the honest one to quote with a caveat: it is
dominated by 11 pathological calls, so it will swing hard on a cohort that
happens to contain none. `superseded read_file`'s 18.5% is the steadier number,
because 14.4% re-read is a stable property of how the agent works.

### 7.3 The protocol, if you do run 10 new sessions

Worth doing — not for the aggregate ratio, but for the three things a live run
can prove that a counterfactual cannot: that the caps hold in production, that
nothing regressed, and that the marker text reads correctly to the model.

1. **Freeze the baseline first**, so the cohorts can never be averaged:

   ```
   python scripts/analyze-session-tokens.py --counterfactual > docs/reports/token-baseline-preFix.txt
   ```

2. **Note the cutoff timestamp**, then run the 10 sessions on real work —
   not synthetic prompts. Include at least one search over a directory holding
   minified JSON or a lockfile; that is the case fix 1 exists for.

3. **Score only the new cohort:**

   ```
   python scripts/analyze-session-tokens.py --since 2026-08-28 --counterfactual
   ```

4. **Read it as pass/fail, not as a percentage.** These are deterministic
   guardrails, and n=1 is enough to fail one:

   - `search_code` **max** must be ≲ 20,000 tokens. Any six-figure value means
     a cap is not on the path that produced it.
   - `saved %` for the `search_code` row should be near **0%** — the results
     are now being *recorded* already capped, so there is nothing left for the
     counterfactual to remove. A large saving here means the fix is not live
     (stale VSIX: a new build needs a **full window reload**, not an exthost
     restart).
   - No new `Error:` results from `search_code` or `read_file`.

5. **Judge quality by hand, not by counter.** Read the transcripts for the two
   failure modes these fixes could plausibly introduce: the agent asking to
   re-read a file it was told is superseded, and the agent missing a match
   because the kept snippet window was centred wrong. Neither shows up in a
   token count — which is the whole reason §5 stayed unimplemented.

### 7.4 What is still not measured

Success rate. Nothing here proves the agent completes tasks as well as it did,
only that it is shown the same information more compactly. That claim rests on
the design rules (§2 "cannot lose signal that was ever recoverable", §3 "a
later complete copy is provably present") rather than on evidence — which is
exactly why §5's changes, which cannot make that argument, need the replay
harness before they land.
