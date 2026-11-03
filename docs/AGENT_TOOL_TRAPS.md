# Agent Tool Traps

Root causes behind the eight tool faults fixed in 0.12.47, written down so the
next tool added here does not repeat them. Every one of these presented as
"the local model is misbehaving" and turned out to be a tool.

This is the public version of the private agent guidance in `CLAUDE.md`.
It keeps the reusable lessons while omitting private investigation evidence.

Things that silently cost the local agent whole turns. Check these before
concluding a model is misbehaving — most "bad model" reports here were tools.

**Auditing what the agent actually did.** Session logs are JSONL under
`~/.forge/sessions/`. Assistant rows carry `tool_calls: [{name, input}]`, and
the `tool` rows that follow carry results — pair them positionally for per-tool
failure rates. The rendered chat hides tool failures entirely; the transcript
will look fine while a tool fails half its calls.

**Deduplicate a session log before you count anything in it.** Older session logs can re-append the full conversation when a window reloads, so resumed sessions may contain replayed rows. Hash each row without `timestamp_ms` and keep first occurrences, while remembering that this also collapses legitimately repeated rows. When `cursor` rows exist, prefer them: rows that re-cover already-written positions are replays. `ArchivedSessions.readLogRows` implements both. Use `session_start.forge_version` to identify which build served each stretch of the file.

**The workspace root is not the project root.** Every `path`, `cwd`, and glob
resolves against `workspaceFolders[0]`, but the agent is routinely pointed at a
repo *nested* inside it. Any new tool taking a path must say so in its schema
description, and any tool spawning a subprocess must derive its cwd from the
target (see `gitCwd()` in `src/tools/gitRepo.ts`) rather than assuming the root.

**Never match a guard pattern as a substring.** Two separate bugs came from
this: the `rm -rf` denylist matched any bare `r` in a later filename
(`git rm -f README.md` refused, `git rm -f notes.txt` allowed), and the
shell-operator guard matched `;`/`<` inside `node -e` scripts. Commands spawn
with `shell: false`, so operator characters inside an argument are inert.
Match whole tokens. A guard that refuses legitimate work teaches the agent the
capability does not exist, and it goes looking for a workaround.

**Refusals must name the sanctioned alternative.** `delete_file` went uncalled
across ~3,000 tool calls while the agent reached for shell `rm` and got a bare
refusal. `DenyListEntry.alternative` exists for this.

**One round per tool call is the scarcest resource.** Prefer batch-capable tool
shapes (`edit_file`'s `edits[]`) over one-call-per-change. `max_tool_rounds`
(defaults/group/model, **default 1000** — `MAX_TOOL_ROUNDS` in
`src/sidebar/ModelTurn.ts:66`) bounds a runaway loop — it is not a judgement
about how large a task may be.

**VS Code API shapes vary at runtime.** `executeDefinitionProvider` is typed
`Location[]` but the JS/TS server returns `LocationLink[]`. Language providers
also need `openTextDocument` first, or they analyse nothing and report nothing.

**Two file-matching engines will disagree.** `find_files` used
`vscode.workspace.findFiles` while `search_code` used ripgrep; on a mapped
network drive the VS Code index reported "no files match" for files that exist.
Both use ripgrep now — keep it that way.

**Anything written to the session log is the only forensic record.** If a field
is dropped there (reasoning on `tool_calls` turns was, until 0.12.47), the
behaviour it explains becomes undiagnosable after the fact.

**A tool that lies costs more than a tool that fails.** `ask_user` returned the bare string `(cancelled)` when its input box was dismissed, including when a focus change dismissed it before the user saw it. The model read that as a user refusal, while nothing in the rendered chat exposed what happened. If a tool appears to mislead the agent, inspect its return value and make failures give relevant recovery guidance at the point of use.

**A lifetime failure rate is not a current one.** A tool’s observed rate can reflect provider billing, a retired tool, a changed model or configuration, or a real current defect. Separate those causes before drawing a conclusion; small samples do not establish that a tool is healthy or failing.

When comparing model configurations, identify the exact build and relevant settings for each observation. Do not attribute a change to one setting when the build, model, or cache configuration changed at the same time. Keep unmeasured rates labeled unmeasured, and record how the failures were counted.

**Order matters: rule out the tool FIRST, accept the quant LAST.** Both audits
found the agent working around broken tools, not a weak model — "it's the quant"
is the most convenient explanation available and the hardest to falsify without
a controlled test, so reaching for it early is the same mistake as blaming the
model, in better clothes. And when the quant really is the constraint, the lever
is the tool contract, not prose: if verbatim reproduction is what degrades, ship
a tool that does not demand verbatim reproduction.

**Weight quantization and KV-cache quantization are two variables, not one.** Anything the model must reproduce exactly from earlier in the conversation — for example, expected lines in an edit request — is read back through the KV cache, so a low-bit cache is a suspect for that failure shape independent of the weights. Read the active configuration values for `type_k` and `type_v` before blaming either; they may differ by group and model, and stale notes can mislead. Vary them separately or the next measurement will be as unattributable as the last one.

**Prompt templates live in `config/templates/builtin/` only.** `TemplateEngine`
loads them (see `extension.ts`); the old diverged `src/templates/builtin/` copy
is deleted, and `ShellRefactorGuards.test.ts` keeps it that way.
