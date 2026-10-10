# Prompt conflicts fix plan (2026-10-10)

**Goal:** make Forge send the model one consistent rule set that never overrides
what the user typed, fail visibly when that rule set cannot be built, and stop
pointing the model at tool behaviour the tools do not have.

**Status:** all decisions made by the owner on 2026-10-10; implementation
authorised the same day. Implementation is delegated to Codex (`gpt-6-luna`,
reasoning effort high) and reviewed by Claude. **No tests are run in this
pass** (owner, 2026-10-10): the gates are `type-check` and `lint`; new and
updated test files are written but not executed until the owner says so.

**The decision in one line:** one rule set, the built-in `execute.njk`, plus three
short lines, plus a clean-up line (D2b). The old 25-line block leaves the
configs. The `audit` profile is removed everywhere (D5).

**Where this came from:** the pi / Cline / OpenCode harness comparison
(`harness-bench-grader/results/harness-compare-2026-10-10/`). The built-in
template `config/templates/builtin/execute.njk` is current against the tool code:
every tool and parameter it names still exists. The problems are around it.

---

## Findings (with evidence)

| # | Finding | Evidence |
|---|---|---|
| F1 | Strata gets two system prompts. `defaults.system_prompt` (an old 25-line rule set) is appended under `execute.njk` (mode `append`). The two disagree on final-answer length and on how much to verify. | `.forge/config.yaml:72`; `ConfigResolver.ts:262`; `SystemPromptInjector.ts:55` |
| F1b | That rule set was measured and retired on 10-07/10-08 but survived in two places. a34cc7a: it "roughly doubled decode time on the harness bench without changing results" (909 s vs 539 s). 1aaec4e removed it from the starters (`StarterConfig.test.ts:114`: "a starter adds none"). It is still in the owner's config and in the shipped `config/config.example.yaml:118`, which no test guards. | git log; files above |
| F2 | Nothing lets the user's own words beat a workflow rule. The template yields only on *format*. On 10-09, pelican-svg ("do not use any tools") made 10 tool calls after its one write, and the `http.server` it started kept running. The old fallback prompt had an override line, but the template does not. | `execute.njk:11-13`; `SystemPromptInjector.ts:10`; `extra-tests-2026-10-09/PELICAN-SVG-TOOLS.md` |
| F3 | A template render error is swallowed. `injectSystemPrompt` catches it and sends a different hardcoded 5-line prompt, with no message. | `SystemPromptInjector.ts:44-48` |
| F3b | The in-extension benchmark always sends that hardcoded prompt: `arms.ts` passes no `TemplateEngine`, so its "Forge" arm never runs Forge's real rules. | `src/benchmark/arms.ts:227` |
| F4 | The FORGE.md starter says "wait once with monitor_execution for as long as it needs", but `wait_ms` is capped at 60 s. | `ForgeInstructionsLoader.ts:32`; `backgroundExecutionTools.ts:19` |
| F5 | `search_code` is literal-only (`--fixed-strings` since v0.12.3, no reason recorded). The prompt sends the model to it, and the shell description sends it to `rg` too. Any regex search ends up in shell. Every other harness searches by regex: OpenCode `grep`, Cline `search_codebase`, Claude Code Grep, and pi and Codex through `rg`. | `dirTools.ts:314`; captured tool schemas |
| F6 | The path line names `path`, `cwd`, `include`; `find_files` takes `pattern`. | `execute.njk:18-19`; `dirTools.ts:183` |

---

## Decisions

### D1: the old 25-line rule set (DECIDED: consolidate into one rule set)

**Decision:**
- Delete the block from `.forge/config.yaml` and `config/config.example.yaml`.
- Of its 14 rows, three ideas move into `execute.njk`:
  - row 5, "never search a whole drive";
  - row 12, narrowest verification, replacing "Verify the change before calling it done";
  - row 6, scope as a hard constraint, carried by D2's override line.
- Row 10, the audit acceptance matrix, is dropped with the `audit` profile (D5).
- Row 4, "check online", is dropped from global rules; it belongs in a project's FORGE.md where wanted.
- Everything else is dropped as covered or conflicting.

**Why:** a34cc7a measured this block on the harness bench at 909 s against 539 s (five-line prompt, mean of 3) and 489 s (three-line), with the same results.

The table below is the line-by-line review the owner asked for. Left: each rule in
`defaults.system_prompt`. Middle: what `execute.njk` already says. Right: my
recommendation. **Tick the rows you want kept.** A kept rule moves into
`execute.njk` as one short line, and every line kept is paid on every turn.

| # | Old rule (`defaults.system_prompt`) | `execute.njk` today | Recommendation |
|---|---|---|---|
| 1 | "You are Forge, an autonomous software-engineering agent operating inside VS Code." | "You are Forge, a coding assistant running in the user's VS Code." **Two personas.** | Drop |
| 2 | "Complete the user's requested task using the available workspace, tools, and evidence. Prefer direct action over narrating intended actions." | "Act with tools: write code into files… instead of showing it in your response" | Drop (covered) |
| 3 | "Inspect relevant existing code before making assumptions or changes. Search for existing implementations before creating new mechanisms; prefer extending existing architecture." | "Read a file before editing it…"; "Before adding a function, module or dependency…, search for one that already does it." | Drop (covered) |
| 4 | FRESHNESS: "When uncertain about a technical fact that may have changed since training… verify it from current authoritative online sources… Prefer primary sources." | nothing | **Your call.** It only works when web_search/web_fetch is on, and as a global rule it asks the model to doubt itself on every turn. It fits better in a project's FORGE.md. |
| 5 | PATHS: "search the workspace and config first… trace a path the code constructs… targeted searches… **Never recursively search an entire drive** unless targeted searches failed." | search_code rule; workspace-root path lines | **Your call.** "Never search a whole drive" is the one line here with no equivalent. Keep it if it came from a real incident. |
| 6 | "Make the smallest coherent change… Preserve existing behavior outside the requested scope. **Treat explicit scope restrictions as hard constraints.**" | nothing | Fold the last sentence into D2's override line. Drop the rest. |
| 7 | "After each result, determine what is still required… If complete and sufficient evidence exists, stop investigating and answer." | "When the task is done and the evidence is in hand, stop." | Drop (covered) |
| 8 | "Do not repeat equivalent searches, reread information already available… At large context sizes, prefer targeted searches." | "…unless its current content is already in a recent tool result" | Drop |
| 9 | "Do not invent file contents, repository structure, command output… Do not claim something was changed… unless evidence supports it." | "Do not claim anything you have not seen in a tool result" | Drop (covered) |
| 10 | "For audit, review, or GO/NO-GO tasks, build an acceptance matrix… verify the implementation path, every user-facing surface, failure behavior, race/restart behavior, and a test." | "When the answer itself is the deliverable (a review…), give every finding, one line each" **Conflict.** | Drop. The audit procedure belongs in the audit prompt the owner writes, not on every turn. |
| 11 | "Continue autonomously through ordinary multi-step work. Do not stop merely to report progress… Ask only when required information cannot be obtained…" | nothing | Drop. 10-07 named "autonomy rules" among the slow parts. |
| 12 | "When verification is appropriate, use the narrowest useful verification. Do not perform unrelated testing, cleanup, or refactoring." | "Verify the change before calling it done." **Conflict** (when and how much). | **Your call.** Option: change the template line to "Verify the change with the narrowest check that proves it." a34cc7a's five-line prompt kept this rule. |
| 13 | "Once the requested work is complete, stop." | "…stop." | Drop (covered) |
| 14 | "Finish with a concise summary of what was done or found, relevant verification, and genuine unresolved issues." | 8-line final answer with the same parts | Drop (covered, and the template is stricter) |

Whatever is kept, the block is deleted from `.forge/config.yaml` and
`config/config.example.yaml`, and a test stops the example from carrying a
`defaults.system_prompt` again (the same rule the starters already follow).

### D2: should the user's words beat the built-in rules? (DECIDED: yes)

Add one line to `execute.njk`:

> Your instructions from the user, in the first message or any later message,
> override these rules and the project instructions wherever they conflict.
> Tool permissions, approvals and the destructive-command rule never yield. If an
> instruction stops you verifying, say in the final answer what you did not
> verify.

**For:**
- "No tools", "don't run tests", "don't open a browser" and "just answer" are obeyed. The 10-09 pelican would have stopped after its one write instead of making 10 calls.
- A direction you send mid-run (a steer) redirects the agent rather than competing with the template.
- Fewer rounds on tasks that ask for less, because the template stops adding work you did not ask for.
- Safety is untouched: approvals, permissions and the shell policy are enforced in code, not by the prompt.

**Against:**
- Work you tell it not to check ships unchecked. The mitigation is the last sentence: the final answer must say what was not verified.
- A casual phrase ("quick fix", "just do X") may be read as permission to skip the FORGE.md gate (`npm run ci`). The mitigation is to write "explicit instructions" so that only a direct instruction counts. This is the real cost: a weaker model may over-apply it.
- Bench prompts that say "do not iterate" may produce worse pages. But that is what those prompts ask for, and the other harnesses are graded the same way.
- One more line, paid on every turn (~60 tokens), and one cold prefill per chat after the upgrade.

**D2b (DECIDED: yes):** "Before finishing, stop any server or background job
you started, unless the user asked to keep it." This would have caught the 10-09
`http.server`.

### D5: remove the `audit` profile everywhere (DECIDED)

The owner chose less complication over a profile that carries audit rules. The
`audit` profile, its `reasoning_effort: medium` and its temperature 0.25 are
deleted from `config/config.example.yaml`, from the owner's `.forge/config.yaml`,
and from every model's `profiles:` list and any doc or starter that names it.
No audit rules move anywhere. Q2 and Q3 are moot.

### Draft of the consolidated `execute.njk` rules (changed lines only)

```
- Verify the change with the narrowest check that proves it.
- Never search a whole drive; search the workspace or a named folder.
- The user's instructions, in the first message or any later message, override
  these rules and the project instructions where they conflict. Tool permissions,
  approvals and the destructive-command rule never yield. If an instruction
  stopped you verifying, say in the final answer what you did not verify.
- Before finishing, stop any server or background job you started, unless the
  user asked to keep it.
- To locate code, use search_code (ripgrep regex; `literal: true` for plain text)…
- (path line) Every `path`, `cwd`, `include` and find_files `pattern` resolves from…
```

### D3: template render failure (DECIDED: fail the turn visibly)

Delete the hardcoded `SYSTEM_PROMPT`. A render error becomes a typed
`SystemPromptRenderError` (template name plus the Nunjucks message) that ends
the turn with that text in the chat and a `turn_error` row in the session log.
`arms.ts` must then pass the real `TemplateEngine`, which also fixes F3b. The
`replace` mode (a model's own prompt, e.g. the Greek Gemma) never touches the
template and is unchanged.

### D4: search_code (DECIDED: regex by default, `literal` flag)

- Drop `--fixed-strings` unless `literal: true`.
- New schema property `literal: { type: 'boolean', description: 'Match the query as plain text (default false: ripgrep regex).' }`.
- Invalid regex: ripgrep exits 2 with `regex parse error`. Return that message plus "Escape the special characters, or retry with literal: true." This is a tool result, not a thrown failure, so it does not count against `ToolFailureTracker`.
- The miss message changes from "literal text search…" to name the mode actually used.
- The benchmark copy in `src/benchmark/toolHost.ts:182` gets the same contract, so the arms stay comparable.
- The description says "ripgrep regex" so the model knows the dialect (no lookaround, no backreferences).

---

## Phases

Each phase passes `npm run type-check` and `npm run lint` (no test runs in
this pass, per the owner) and is committed to main. Nothing in the owner's
config is edited while a Forge turn is running (`/slots` idle, no jobs running).
After the last phase: `npm run package`, install the VSIX.

1. **D3: render errors surface.** Edit `SystemPromptInjector.ts` (remove the fallback, throw the typed error), `PromptRun.ts` and `prepareModelTurnMessages.ts` (let it reach the turn error path), and `arms.ts` (pass the engine).
   Tests: a broken template ends the turn with the error text; no prompt is sent; a grep guard finds no hardcoded "You are Forge" outside `config/templates/`.
2. **D4: regex `search_code`.** Edit `dirTools.ts` and `benchmark/toolHost.ts`.
   Tests: a regex matches (`\.heal\(`); `literal: true` matches `foo(`; an invalid regex returns the hint without throwing; the miss message names the mode.
3. **F4 + F6 wording.**
   - Starter: "wait with monitor_execution, reusing its suggested_next_wait_ms (each call waits up to 60 s), instead of polling in short steps".
   - Template path line: "Every `path`, `cwd`, `include` and `find_files` `pattern` resolves from…".
   - Template search line: "To locate code, use search_code (ripgrep regex; `literal: true` for plain text)…".
   - Existing FORGE.md files are user-owned and are not rewritten. Forge's own FORGE.md does not contain the old line (checked).
4. **The consolidated rules into `execute.njk`.** Use the draft above, including D2b. Update `forgeTuningPrompt.test.ts`.
5. **D1 cleanup + D5.**
   - Delete the block from `config/config.example.yaml`, and add the example to the "a starter adds none" test. Delete the example's `audit` profile and every reference to it.
   - Then, with Forge idle, take a backup of the owner's `.forge/config.yaml` (untracked, so git cannot restore it). Remove the block, the `audit` profile and every `audit` entry in models' `profiles:` lists.
6. **Measure (on the owner's go only).** One Forge pelican-svg run on Strata with the same parameters as the two baselines and pi (temperature 0.6, top_p 0.95, max_tokens 32000, xhigh). Compare tool calls, wall time and tokens. Bench workspaces never had the old rule set, so this measures D2/D4 alone.

## Open questions

None. Q1 (D2b) = yes. Q2 and Q3 are moot: the `audit` profile is removed (D5).

## Implementation notes (2026-10-10, 0.17.2)

- The owner also removed the `subcoordinator` and `worker` profiles from `config/config.example.yaml` (Relay leftovers; no Forge code uses them). Only `main` remains.
- The persona guard matches `You are Forge,` only, so the Telegram contact policy ("You are Forge's assistant") is a separate prompt and stays.
- `scripts/forge-bench.mjs` bundles the benchmark into a temp folder, so it injects the template folder as `FORGE_BENCH_TEMPLATE_DIR` at build time; `arms.ts` throws if it is missing.
- Owner config: backup at `.forge/config.yaml.bak-2026-10-10`; the old block and the `audit` profile are removed.
- Tests were written but not run, at the owner's instruction. `type-check` and `lint` pass.

## Related, outside this plan

- The bench config (`hb-runs/forge/.forge/config.yaml`) no longer sets the Strata entry's `max_tokens: 32000`, although its header says it does. Today's Forge pelican run therefore ran with the 200000 default. Restore it before the next Forge bench run, so all harnesses match.

## Files touched

- `config/templates/builtin/execute.njk`
- `src/llm/SystemPromptInjector.ts`
- `src/sidebar/PromptRun.ts`
- `src/sidebar/prepareModelTurnMessages.ts`
- `src/benchmark/arms.ts`
- `src/benchmark/toolHost.ts`
- `src/tools/dirTools.ts`
- `src/llm/ForgeInstructionsLoader.ts`
- `config/config.example.yaml`
- `test/unit/forgeTuningPrompt.test.ts`
- `test/unit/StarterConfig.test.ts`
- new tests for D3 and D4
- `CHANGES.md`
- the owner's `.forge/config.yaml` (by hand, not committed)

No new module, so no `docs/OWNERS.md` row.

## Acceptance criteria

- A Strata request from the owner's Forge carries exactly one rule set: no "autonomous software-engineering agent" text. Checked with a proxy capture.
- `config/config.example.yaml` and all three starters have no `defaults.system_prompt`, enforced by a test.
- A broken `execute.njk` ends the turn with the render error visible in the chat. No request reaches the model.
- The benchmark Forge arm sends the rendered `execute.njk`.
- `search_code` finds `\.heal\(` as a regex and `foo(` with `literal: true`. An invalid pattern returns the hint as a result, not a failure.
- (If D2 is accepted) the pelican-svg prompt, rerun on the owner's go, makes no tool call after its write except any the prompt allows, and the final answer names what was not verified.
- `npm run ci` is green after every phase.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `defaults.system_prompt` in the owner's `.forge/config.yaml` | Already exists (owner-authored) | Phase 5, by hand, after the backup | Removing the field is the disable; `system_prompt_mode` is unaffected | One editor write. Half-written YAML fails Forge's schema validation, which shows the error; restore from the backup | Not applicable: Forge rereads the config on change and on reload | None |
| Backup `.forge/config.yaml.bak-2026-10-10` | Phase 5, before the edit | After the owner confirms one Strata turn with the new prompt | Not applicable (inert file, never read by Forge) | A partial copy leaves the original untouched; copy again | Not applicable | Deleted at the confirmation above; a second session must not delete it unconfirmed |
| `defaults.system_prompt` in `config/config.example.yaml` | Was added in d23c87d | Phase 5 commit | Not applicable (example file, copied by users, never loaded) | Tracked by git; `git checkout` restores it | Not applicable | None. **CI row:** `StarterConfig.test.ts` asserts the example has no `defaults.system_prompt` |
| FORGE.md starter text (`STARTER_CONTENT`) | Written into a workspace's FORGE.md only when none exists | Never deleted by Forge; files are user-owned | `forge_instructions.auto_create: false` | `wx` flag: the file is created whole or not at all (existing code) | Not applicable | None; older FORGE.md files keep the old wording (accepted, owner-edited) |
| `search_code` schema in each request | Each request | Not applicable | The tool's permission gate (unchanged) | Not applicable (not persisted) | Not applicable | Not applicable. The changed schema costs one cold prefill per chat, once |

## Out of scope

- `reasoning_budget_message`.
- The Qwopus model-level prompt.
- Re-tuning any other template rule.
- Cline/OpenCode reruns.
- Rewriting existing users' FORGE.md files.
