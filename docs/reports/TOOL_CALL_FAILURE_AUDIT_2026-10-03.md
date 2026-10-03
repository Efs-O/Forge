# Tool-call failure audit — session `d21dd084-b186-4cb1-9d75-c3ce857ecf5f`

Written 2026-10-03. **Status: A–C implemented in the working tree; CI green;
packaging blocked by the existing same-version VSIX.**

## Implementation decision

Implement the three bounded error-message changes in this report: a unique
truncated-name hint, a concrete boolean correction, and a missing-field message
for `apply_line_edits`. Keep tool names, schemas, descriptions, system prompts,
permissions, and dispatch behavior unchanged. Do not add a general fuzzy matcher,
enumerate tool catalogs in errors, or auto-correct or execute a rejected call.

**Context budget:** successful turns add **zero** prompt text. Each changed
refusal replaces an existing result with at most one short hint (200 characters
total for that result). The implementation report must show the old and new
result lengths for the three cases and confirm that serialized tool definitions
are unchanged. A hint is emitted only after a failed call, never in every model
request.

Source snapshot: `C:/Users/efso office/.forge/sessions/d21dd084-b186-4cb1-9d75-c3ce857ecf5f.jsonl`
(4,323,962 bytes, 3,970 rows, mtime 2026-10-03T09:04:41Z). The live log
continued to grow after this snapshot; counts below apply only to it. Model
`strata-flashnext-iq3s`, `forge_version` 0.16.76, workspace `n:\vs code apps\Forge`.

Row census: 1,492 `cursor`, 970 `tool`, 731 `usage`, 729 `assistant`, 42 `user`,
5 `session_start`, 5 `compaction`, 5 `turn_error`.

The 5 `turn_error` rows are all `fetch failed: connect ECONNREFUSED
127.0.0.1:8090` — the local backend was unavailable. The log alone does not
establish why; these rows are outside this tool-call fix.

## Method

Every `tool` row was joined to the `assistant.tool_calls` row that produced it
(`tool_call_id` → `{name, input}`), so each failure is judged on the **recorded
call and the recorded result**, not on inference. 93 rows looked like failures;
most are ordinary red test runs (`vitest`/`npm test` exit 1). The genuine
tool-call defects:

| # | Case | Count | Cause |
|---|---|---|---|
| 1 | `unknown tool "render_html"` | 1 | Model invented the name (sent with empty args `{}`) |
| 2 | `"True"`/`"False"` for a boolean field | **6** | Model emitted Python-style spellings as JSON strings |
| 3 | `exec_command needs a JSON array for "args"` | 4 | Model passed a string holding one |
| 4 | missing required argument | 6 | Model wrong/omitted fields |
| 5 | `edit_file: old_str not found` | 10 | Model quoted text from memory |
| 6 | `apply_line_edits` type errors | 3 | Model omitted nested-required fields |
| 7 | `commit … nothing is staged` | 2 | Model skipped `stage` |
| 8 | `git … unknown option: -n` (exit 129) | 1 | Model omitted the `grep` subcommand |
| 9 | `send_file` path refusal | 1 | **Correct refusal** — the model's own security probe |

## Repeated boolean error in this snapshot

Case 2 is the only class observed to **repeat on immediate retry**. At
`ts=1790989164612` the model received the boolean error, and its very next call
carried `background:"True"` again:

```
exec_command @1790989164612 -> next exec_command: STILL "True"/"False"
```

The other recorded classes recovered on the following call in this snapshot.
Recorded args:

```json
{"background":"True","command":"npm","args":["run","ci"],"cwd":".","notify_on_exit":"True"}
{"path":"test/integration/RenderHtmlPosterSmoke.test.ts","recursive":"False","to_trash":"True"}
{"html":"<title>…</title>","width":900,"height":532,"full_page":"True"}
```

It spans three different tools (`exec_command` ×4, `delete_file` ×1,
`render_html_to_image` ×1), so it is a systemic **message** weakness, not a
schema weakness. The `full_page` case the user reported is one instance of a
six-instance pattern. The immediate repeat shows that the current text —
*"Resend the call with a bare boolean"* (`src/tools/ToolRegistry.ts:154`) — did
not correct that retry. A more concrete error may help; the log cannot prove
that it will eliminate future repeats.

## Verdicts on the four named cases

**1. `render_html` — model mistake; Forge's message is the defect (minor).**
`src/sidebar/ToolDispatch.ts:163-167` returns a bare
`Error: unknown tool "render_html"`. The repo already knows this shape is wrong:

- `docs/plans/VIDEO_ATTACHMENT_PLAN.md:227-228` — *"This is the 'refusals must
  name the sanctioned alternative' rule … A bare 'unknown tool' is what sent the
  agent looking for `rm`."*
- `src/tools/imageTool.ts:82` and `src/tools/videoTool.ts:30` — a bare
  "unknown tool" **taught the agent the tool didn't exist**.
- Forge already fixed the neighbouring case: `ToolDispatch.ts:152-158` explains
  why a registered-but-withheld tool is unavailable, *"so the model does not go
  hunting for a substitute."*

The misnamed-call path is the one left bare. No nearest-name matcher exists
anywhere in `src/` (searched: `levenshtein`, `edit distance`, `fuzzy`,
`did you mean` — zero matches).

**2. `full_page: "True"` — model mistake; Forge's guard is correct.**
`ToolRegistry.invalidArgs` (`src/tools/ToolRegistry.ts:150-155`) refuses a
declared boolean sent as a string/number, naming the field and the value.
`ToolDispatch.ts:168-174` returns it and `continue`s — the handler never runs, so
nothing is rendered or queued — and calls `failureTracker.record(convId)`.
Deliberate, per the comment at `ToolRegistry.ts:125-137`: a backend once sent
`background: "True"`, handlers test `=== true`, and the job silently ran in the
foreground and hit its deadline "with nothing saying why." Pinned by
`test/unit/ToolDispatch.test.ts:259`. The tool schema is valid
(`src/tools/renderHtmlToImageTool.ts:83-86`, `type: 'boolean'`); nothing in it
invites a string. **Keep strict; fix the message only.**

**3. `git -n` — model mistake, not a defect.**
Recorded args: `command:"git"`, `args:["-n","thumbnail(s)|Sent |…","--","test/unit/ImageSearchTool.test.ts",…]`
— the `grep` subcommand was dropped, so `-n` became a top-level git flag
(exit 129, `unknown option: -n`). git's own usage text is the best diagnostic and
Forge passed it through faithfully. Separately: `git grep` exit 1 = no match, and
untracked files are invisible to `git grep` — correctly **not** a defect.

**4. `send_file` rejected path — correct refusal; no change needed.**
Recorded: `{"path":"C:\\Windows\\win.ini"}` →
`Error: path must be in the workspace or this conversation's screenshot directory.`
The transcript shows the model *deliberately* probing this as a security test.
Containment is correct (`src/tools/sendFileTool.ts:18-66`: `resolveRealWorkspacePath`,
then a realpath'd per-conversation screenshot root with junction/symlink
equality checks). The existing refusal already names both allowed locations;
echoing an absolute path and workspace root would add text to a deliberate
security probe without improving this case.

## A real Forge gap not named by the user

`apply_line_edits` declares `required` **inside** its array items
(`src/tools/structuredEditTool.ts:110`), but `invalidArgs` only checks
top-level `parameters.required`. So an *absent* `start_line` surfaces as a type
error — `operation 1 start_line must be an integer`
(`structuredEditTool.ts:245`) — which is misleading: nothing had the wrong type,
the field was missing. Recorded args confirm it:
`{"operations":[{"end_line":37,"expected_lines":[…],"replacement_lines":[…]}]}`.
A second row shows `"expected_lines":[null]` → `has invalid expected_lines`.

## Implementation steps

| Fix | Owner and behavior | Focused verification |
|---|---|---|
| **A. Unique truncated-name hint** | In `ToolDispatch.ts`, when an unknown name is a prefix of **exactly one** eligible registered tool name (minimum 5 characters), add one short hint. For `render_html`, name `render_html_to_image`. If its `media` group is unloaded, say to call `load_tool_group` with `"media"` first. If there is no unique eligible match, keep today's bare error. No edit-distance search, new matcher module, aliases, or automatic execution. | Test the observed name, unloaded group, ambiguous prefix, and a tool withheld by permission, model allowlist, `advertise`, vision gate, or zero-call budget. No hint may bypass those gates. |
| **B. Concrete boolean correction** | In `ToolRegistry.invalidArgs`, keep rejecting strings. For `"True"` and `"False"`, show the unquoted JSON value beside the offending field (for example, `background="True": use true`). For other invalid values, retain the generic `use true or false without quotes` instruction. Cap the combined message at 200 characters. | Test the observed boolean strings and an unrelated invalid value; confirm the handler does not run. |
| **C. Missing nested field** | In `structuredEditTool.ts`, distinguish absent `start_line` (and the other required operation fields) from a present value of the wrong type. Name only the missing field and operation number; do not repeat the full schema. | Test an omitted `start_line`, a malformed supplied `start_line`, and that neither writes a file. |

For A, derive candidates from the registry's permission- and `advertise`-filtered
definitions, then apply the current model's allowlist and zero-call filter,
vision withholding, and lazy-group state. Reuse the existing filters where
practical instead of maintaining a second tool catalog. If the necessary
eligibility state is not available at dispatch, pass the already-computed
state from `ModelTurn`; do not guess from `ToolRegistry.names()` alone. A hint
for an unloaded group is allowed only when `load_tool_group` itself is usable.

Keep the original `Error: unknown tool "..."` prefix so existing consumers
recognize the refusal. Add a hint only when the combined result stays at or
below 200 characters; a long unknown name keeps the existing refusal unchanged.
`ToolDispatch` still records one result and never calls the
suggested handler. No new source file is needed unless a focused split
materially improves ownership; respect the 500-line source lint limit.

## Explicitly NOT proposed

- `git -n` / `git grep` exit 1 — correct pass-through of git's own diagnostics.
- Listing every optional argument after a missing-argument error — the current
  result already names the required fields, while a catalog dump adds context
  on a failed round without evidence that it helps.
- Echoing a rejected absolute path or workspace root in `send_file` — the
  existing message states the allowed locations and the refusal is correct.
- `commit … nothing is staged` — the message already names the fix (`stage` first,
  or `git_read status`).
- The 6 generic `edit_file` misses — the text was genuinely absent; the improved
  diagnostics already fired on the other 4 (`WAS found at line … differing only in
  leading whitespace`, `Its first line WAS found at line …`), see
  `src/tools/editMatch.ts:86-107,124-150`.
- The budget refusal — `render_html_to_image: the per-turn file delivery limit is
  already spent (0 left). Nothing was rendered.` is correct by design and is the
  behaviour the plan specifies.
- The 5 `turn_error` rows and the `ask_local_agent` delegation timeout — their
  causes are not established by this audit and are outside these three fixes.

## Implementation boundaries and handoff

- Preserve the existing `README.md`, `package.json`,
  `docs/plans/IMAGE_SEARCH_DELIVERY_BUDGET_PLAN.md`, and
  `scripts/llama_sglang_watch.py` work. Do not change the extension version,
  publish, or install a VSIX as part of these error-message fixes. Running the
  repository's packaging gate is still required.
- Do not change tool definitions, descriptions, defaults, system prompts, or
  permission policy to treat model output mistakes as valid calls. Avoid new
  dependencies and a global prompt reminder; both increase steady-state cost.
- Run focused tests for A–C, then the required final gates **after the last
  edit**: `npm run ci`, `npm run package`, `git diff --check`, and `git status`.
  Report exact exit results, three before/after refusal lengths, and whether
  tool-definition bytes changed. If a gate fails, identify whether the failure
  came from this change or the pre-existing working tree.
- A same-version `forge-llm-0.16.78.vsix` already exists. The first
  `npm run package` attempt stops at `check-vsix-version.mjs` before building.
  For the implementation gate, back up that VSIX, run with
  `FORGE_ALLOW_VSIX_OVERWRITE=1`, restore the original VSIX afterward, and
  verify its SHA-256 matches the backup. Do not silently replace the existing
  artifact or bump the version merely to run this gate.
- The report file is currently **untracked** in `git status`. Stage only files
  belonging to this fix if committing; do not sweep in unrelated edits.

## Implementation outcome (2026-10-03)

- **A — Copilot:** `src/sidebar/ToolDispatch.ts` now gives a bounded hint for a
  unique eligible prefix. It reuses registry permission/advertise definitions,
  the model budget filter, vision gate, and lazy-group state. An unavailable or
  ambiguous candidate keeps the original refusal. Verified by
  `test/unit/ToolDispatchUnknownHint.test.ts` (9 tests). `ToolDispatch.ts` is
  475 physical lines, below the 500-line lint limit.
- **B and C — Qwen Q6:** `src/tools/ToolRegistry.ts` gives a concrete correction
  for `"True"`/`"False"` and a bounded fallback for other invalid values;
  `src/tools/structuredEditTool.ts` distinguishes missing nested operation
  fields from wrong types. The edit schema and parser share one required-field
  list, with the same serialized field names as before. Verified by
  `test/unit/ToolCallRefusalMessages.test.ts` (10 tests) and the existing
  dispatch and structured-edit suites. Codex added a long-tool-name cap test
  and the shared required-field list during integration.
- **Context cost:** no tool descriptions or regular prompt text changed.
  Observed refusal lengths: unknown `render_html` 33 → 131 characters
  (unloaded `media` group); `background:"True"` 137 → 47; missing
  `start_line` 59 → 51. A hint only appears after an invalid call and is
  withheld when it would take the result beyond 200 characters.
- **Verification:** focused four-file suite 64/64 passed after Codex's edge
  test; `npm run ci` then passed with 3,953 tests passed and 40 skipped,
  including type-check, lint, production build, and bundle check. The first
  full CI attempt had one unrelated `execTools.test.ts` background-child
  failure; that file passed alone (21/21) and the full rerun passed.
  `npm run package` exits 1 before building because
  `forge-llm-0.16.78.vsix` already exists. The existing artifact was not
  overwritten. No live model retry was run, so reduced model error frequency
  remains unmeasured.
