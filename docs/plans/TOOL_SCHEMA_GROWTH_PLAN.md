# Tool Schema Growth Plan — staying ahead of ~100 tools

**Status:** PARKED (2026-09-15). Step 1 (CI budget) can ship any time; steps 2–3 are
triggered by the budget, not by a date. **Revisit when the native tool count nears
~90, or when the CI budget in step 1 fails.**

## Why this exists

The tool schema is a fixed cost on every request. At 74 tools it is **17,093 tokens**
(~230/tool); at 100 tools that projects to **~23K**, ~18% of a 128K context. A
2026-09-15 investigation tried to get ahead of this by trimming and lazy-loading, and
learned what does and does not work on this model. This plan keeps what works.

## What was tried, and what it proved (read before proposing anything new)

| Doc | What it holds |
|---|---|
| [`docs/TOOL_SCHEMA_REPORT.md`](../TOOL_SCHEMA_REPORT.md) | Token audit. **72% of the schema is JSON structure, 28% prose** — trimming descriptions cannot fix growth. |
| [`docs/proposed/TOOLS_SCHEMA.md`](../proposed/TOOLS_SCHEMA.md) | Prose trim, before→after for 43 fields (−371 tokens). **Not applied**: ~0.3% of context, and rewording hand-tuned descriptions risks behaviour drift. |
| [`docs/proposed/FORGE.md`](../proposed/FORGE.md) | FORGE.md trim (−123 tokens). **Not applied**, same reasoning. |
| [`docs/review/claude-code-review.md`](../review/claude-code-review.md) | Review of both trims: 3 load-bearing losses found. Also why dropping `additionalProperties: false` is **not** safe (`src/sidebar/sessionTypes.ts:157`). |
| [`docs/proposed/FULL_LAZY_DESIGN.md`](../proposed/FULL_LAZY_DESIGN.md) | Full lazy-load of 5 built-in groups (−33%). **REJECTED.** |
| [`docs/proposed/FULL_LAZY_DESIGN_REVIEW.md`](../proposed/FULL_LAZY_DESIGN_REVIEW.md), [`FULL_LAZY_DESIGN_CODEX_REVIEW.md`](../proposed/FULL_LAZY_DESIGN_CODEX_REVIEW.md) | Code reviews of that design (valid on their own terms; premises later disproved). |
| [`docs/proposed/FULL_LAZY_MEASUREMENT.md`](../proposed/FULL_LAZY_MEASUREMENT.md) | **The live measurement that killed it.** |
| [`docs/plans/LAZY_TOOL_GROUPS_EXPERIMENT.md`](LAZY_TOOL_GROUPS_EXPERIMENT.md) | The existing HalluScribe lazy group. Its "cache survives" section is wrong on Qwen3.8 (see measurement). Left as is: loaded in 2 of 203 sessions in 30 days. |

### The three hard facts (llama-server b10894, Qwen3.8-27B)

1. **Any change to the tools array mid-conversation = full cold re-prefill from token 0**
   (95 s at 70K context; tools render in the system block before every turn; hybrid
   model, no partial reuse). Appending at the end does not help.
2. **Tool calls are grammar-constrained to the advertised `tools` array** — names *and*
   parameter names. A hidden tool cannot be called "blind"; the model gets coerced into
   a different tool.
3. **Usage is not rare for the big groups:** in 30 days, git tools were used in 41% of
   tool-using sessions, LSP in 27%, media 5%, power and notebook 0%.

**Rule derived from these:** the tool list may vary **between conversations or models**,
never **within** one.

## Plan

### Step 1 — CI token budget (ship any time)

Turn the manual measurement into a gate so growth forces a decision when a tool is
added, not after reaching 100.

- Promote the counting in `test/measure-prompt-context.manual.ts` into a unit test
  (e.g. `test/unit/ToolSchemaBudget.test.ts`) over `registerAllTools` output.
- Budget in **characters of `JSON.stringify(definitions)`** (no tokenizer in CI); record
  the chars→tokens ratio next to the constant with its measurement date
  (`TOOL_SCHEMA_REPORT.md` §1 has the baseline).
- Set the ceiling ~10% above today's size. The failure message must name the two
  sanctioned responses: merge into a family tool (step 2) or scope by model (step 3) —
  and say raising the ceiling needs a note in `CHANGES.md` stating why.

### Step 2 — merge tool families (when the budget fails)

One tool with an `operation` enum instead of N sibling tools removes N−1 copies of the
structural overhead, which is where 72% of the tokens are. Precedent:
`query_powershell` (`list_processes` added as an operation took that task from 0/14 to
14/14).

Candidates, in order:

| Family | Today | Merged shape | Notes |
|---|---|---|---|
| LSP read | 9 tools (`get_diagnostics` … `find_implementations`, `get_code_actions`) | `code_intel(operation, path, line?, character?, query?)` | Keep `apply_code_action` separate — it writes. |
| git read | `git_status`, `git_log`, `git_diff`, `git_blame`, `git_show` | `git_read(operation, cwd?, ref?, path?, …)` | Keep writers (`stage`, `commit`, `create_branch`, `switch_branch`, `restore_file`) separate — distinct permissions and `restore_file`'s overwrite warning. |
| power | 3 tools | `power(operation, …)` | `sleep_computer` is destructive; merge only if the approval gate stays per-operation. |

Constraints for every merge:
- Strict JSON schema, enum operation — never a free-form string (CLAUDE.md Hard Stop).
- Each operation's gotchas move into the merged description **verbatim**; check against
  the [prose review](../review/claude-code-review.md) list of load-bearing facts.
- Per-operation required params become optional in the schema: the handler must return a
  specific error naming the missing param for that operation (a tool that fails clearly,
  not one that lies — CLAUDE.md "Agent-Ergonomics Traps").
- Measure each merge on its own: tokenize before/after, and compare per-tool failure and
  recovery rates in `~/.forge/sessions` (deduplicated) over the following weeks. Revert a
  merge that raises failures.
- One family per release, so a regression is attributable.

### Step 3 — scope the tool set per model/conversation (when merges are not enough)

The existing per-model `tools:` allowlist (`src/tools/ToolBudget.ts`,
`src/config/schema.ts:99`) already selects tools once per model, which fact 1 allows.
Use it for models that do not need the full set (review/chat-only delegates, small
models). If a per-conversation choice is ever needed, it must be fixed at conversation
start and never change mid-conversation.

### Explicitly out of bounds (already disproven — do not re-propose without new evidence)

- Mid-conversation lazy loading (`hidden` groups) for any frequently used group.
- Delivering tool schemas through tool results or name-only stubs.
- Description-less "skeleton" stubs to save prose (works, but ~2% of context for stripped
  load-bearing warnings).
- Dropping `additionalProperties: false` as a "free" structural slim.

New evidence that would reopen these: a different backend/model with partial prefix
reuse, or a llama-server change to tool grammar constraints. Re-run the scripts described
in `FULL_LAZY_MEASUREMENT.md` first.

## Acceptance criteria

- [ ] **Step 1:** a unit test in `npm run ci` fails when `JSON.stringify` of the
      registered native tool definitions exceeds the recorded character budget —
      validated by temporarily registering a dummy tool and seeing CI fail.
- [ ] Step 1 failure message names step 2 and step 3 and the `CHANGES.md` rule.
- [ ] Step 1 budget constant carries its measurement date and chars→tokens ratio.
- [ ] **Step 2 (per merge):** tokenized schema size before/after recorded in this doc.
- [ ] Every gotcha in the replaced tools' descriptions appears in the merged
      description — checked item by item against the old strings.
- [ ] A call missing an operation-required param returns an error naming that param
      (unit test per operation).
- [ ] Destructive or write operations keep their own approval/permission behaviour
      (unit test: merged tool's read operations auto-approve iff they did before).
- [ ] Session-log failure/recovery rate for the merged tool compared against the
      pre-merge tools after ≥2 weeks of use, result recorded here.
- [ ] **Invariant (all steps):** the advertised tool list is byte-identical across rounds
      of one conversation — unit test serialising the list before and after a
      multi-round turn.
- [ ] **Step 3:** any model-scoped tool set is resolved once per conversation; a unit
      test asserts it does not change between rounds.
