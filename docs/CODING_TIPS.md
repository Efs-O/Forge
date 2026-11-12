# Coding tips

Mistakes that cost rounds, gathered from one place into another: the shipped rules
template, the repo-local instruction file, the tool-traps doc, the tool audit, the
desktop/browser test report, the documentation audit, and measured incidents. Read the
section you are about to act in; you do not need the whole file.

**Not a second copy of the rules.** Anything already in `config/templates/builtin/execute.njk`
belongs there, not here — it is injected every turn in every repo. If a line below reads
like general good behaviour, it is in the wrong file.

**Delete a tip when the code enforces it.** This is a live list, not a bug cemetery: once a
gate refuses the mistake, the prose is noise — say what enforces it instead.

**Adding a line:** one bullet, imperative, naming the cost that earned it. Prefer a gate over
a line — a rule that needs the agent to remember it will be broken again.

## Before acting

- **Establish scope and baseline first.** For an audit, enumerate the exact range in the
  first call; a review that skips this reports on the wrong commits.
- **Check who else is in the tree before editing.** Several agents share this worktree; a
  file changing under you is a collision, not a mystery. Agree ownership, do not revert.
- **Plans describe intent; the code is the truth.** A merged plan can describe behaviour
  that has since changed, and historical plans get mistaken for current architecture.
- **Commit only your own paths, and read the staged diff first.** Never `-A` or `.`.
- **Never set the author.** Commits carry the owner's identity; the co-author line is the
  only line an agent adds.

## Reading and searching

- **Read the file you need; do not list first.** A listing is a round that answers nothing.
- **Search once, across many files.** One regex over the tree beats a call per file.
- **No matches is an answer, not a failure.** Say so and stop; do not widen the search.
- **Before adding a function or dependency, search for one that already does it.**
- **Print the shape before you act on it.** A session lost a round guessing a log field was
  `arguments` when it is stored as `raw_arguments`, and another guessing a filename format.
- **Conclude from a direct probe, not indirect evidence.** An exit code, a header number, or
  a tool's own output each produced a confident wrong answer in one audit; every one had a
  decisive test one call away — the process table, the transform source, an `EnumWindows` probe.
- **Do not claim high confidence before the probe runs**, and check the results you already
  have before citing upstream precedent — the right issue was in the first search's output.
- **A folder-wide search proves a string exists somewhere, not whose file it is.** Read the
  record that identifies the file before attributing a hit.

## Editing files

- **Read before editing, and anchor on text you just read.** Edits against stale text fail.
- **Batch every change to one file into one call.** `edits[]`, not one call per change.
- **Keep the anchor short and unique, copied verbatim** — whitespace and punctuation included.
- **When a value must contain tool-call markup, assemble it from parts.** A value holding a
  closing tag can truncate the call carrying it; this bit twice in one session.
- **One write for a whole file.** Do not split a file into part-files to join later.
- **No second hand-maintained list where the runtime already assembles one.** A hard-coded
  tool list reported 44 tools when the registry had 54.

## Shell and processes

- **Never raise a timeout past the tool's ceiling.** `shell.timeout_ms` ≤ 600000;
  `monitor_execution.wait_ms` ≤ 60000 — reuse the returned cursor instead of waiting longer.
- **Long-running command: background it, then `monitor_execution`.** Silence is not a stuck
  job; a buffered runner emits nothing until it finishes.
- **Do not `cd` into a folder and then write.** The write is judged against the folder the
  command started in; pass `cwd` to the tool, or use absolute paths.
- **Windows switches need PowerShell.** A switch that starts with a slash is read as a path
  under Git Bash; run those calls with `shell: "pwsh"`, or double the leading slash.
- **Quote carefully through three layers.** A regex literal inside a single-quoted `node -e`
  under bash is where quoting dies; prefer plain string comparisons.
- **A destructive command needs the owner's ask, not your judgement.** Recycle-bin deletes
  are recoverable; `to_trash: false` is not.

## Git

- **Fix the cause, not the symptom** — real logic over hard-coded values; never weaken a test.
- **A flaky test is fixed at the lifecycle boundary**, not by raising a timeout: await the
  promise that ends the work, then assert.
- **Do not compare objects by serialized source order.** Property order is meaningless and
  makes false failures; array order is meaningful.
- **Version bumps only in `chore(release): vX.Y.Z`**, update `CHANGES.md` on version changes,
  and record CI before pushing — the gate refuses an unrecorded range.
- **A green run you did not run is not evidence.** `--record-ci` trusts its caller.
- **Keep a retracted claim in the record, corrected.** It stops the next person repeating it.

## Tests and gates

- **Run the gate that covers the change, and name the one you ran.** Type-check, the specific
  test files, lint, then the full suite before a push.
- **A harness that emits calls but never dispatches them proves schema compatibility, not
  that the handler works.** Writes, deletes, commits and launches were deliberately
  unexecuted in the tool audit — a green inventory is not verified behaviour.
- **Test files are not type-checked or linted here** — `tsconfig.json` excludes `test/` and
  eslint covers only `src` and `webview-ui`. Only vitest running them catches a type error.
- **A failing test you did not expect is information.** Read which assertion failed before
  touching code; twice in one session the existing behaviour turned out to be the right one.
- **A red test in another agent's uncommitted file is theirs.** Name it, leave it.

## Paths

- **The workspace root is not the project root.** Paths, `cwd` and globs resolve against
  `workspaceFolders[0]`; a repo nested inside it needs its own prefix.
- **`docs/plans/` and `docs/reports/` are local only** — a missing file in `git status` is
  not a failed write. `docs/*` is ignored unless re-admitted by name, and shipping needs a
  matching line in `.vscodeignore` plus the allow-list in `scripts/check-vsix-contents.mjs`.
- **Session logs are named with the chat's full id** while chat lists shorten ids:
  `~/.forge/sessions/<full-id>.jsonl`; resolve a short id with a prefix glob.
- **Outside-workspace files need `extra_file_roots`** before deletion, and deletion stays
  approval-gated regardless.

## Other agents

- **Delegate for thinking, not for typing** — a plan, an adversarial review, a second opinion
  where being wrong is expensive.
- **A review of something already written goes to a new session**; a reviewer that helped
  write it agrees with it by construction.
- **Never claim a delegate ran unless the tool returned its result.**
- **Do not edit files you asked another agent to change.**
- **Give the delegated agent the files** — a local model target has no tool channel and
  cannot open the repository itself.

## Forensics

- **Deduplicate a session log before counting anything in it**; pre-0.13.20 logs re-append
  the whole conversation on reload, and one audited file was 65% duplicate rows.
- **A lifetime failure rate is not a current one.** Date it by build and quant before
  believing it; two "failing a third of the time" tools were measuring something retired.
- **Suspect the tool before the model.** Most "the model is misbehaving" reports here were
  tools; read the tool's return string first.

## Reporting to the owner

- **Plain English first, detail last.** Paths and hashes go under "Detail for the record".
- **Say what you measured versus what you only read**, and state one caveat when one exists.
- **Do not claim verification you did not do.** A grep hit is not a transcript; if you
  inferred, say inferred.

---

Sources: `config/templates/builtin/execute.njk` (rules deliberately not restated), `FORGE.md`,
`docs/AGENT_TOOL_TRAPS.md`, `docs/WORKSPACE_FORENSICS.md`, `docs/local/FORGE_TOOL_AUDIT_AND_IMPLEMENTATION_PLAN.md`,
`docs/DESKTOP_BROWSER_TOOL_TEST_REPORT.md`, `docs/DOCUMENTATION_AND_ROADMAP_AUDIT_0.16.md`,
`CLAUDE.md` § gates and push hygiene, and incidents measured in the 2026-11-12 session.
