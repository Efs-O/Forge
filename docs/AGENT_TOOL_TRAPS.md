# Agent Tool Traps

Root causes behind the eight tool faults fixed in 0.12.47, written down so the
next tool added here does not repeat them. Every one of these presented as
"the local model is misbehaving" and turned out to be a tool.

This is the tracked copy of the section in `CLAUDE.md` (which is gitignored).

Things that silently cost the local agent whole turns. Check these before
concluding a model is misbehaving — most "bad model" reports here were tools.

**Auditing what the agent actually did.** Session logs are JSONL under
`~/.forge/sessions/`. Assistant rows carry `tool_calls: [{name, input}]`, and
the `tool` rows that follow carry results — pair them positionally for per-tool
failure rates. The rendered chat hides tool failures entirely; the transcript
will look fine while a tool fails half its calls.

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
(defaults/group/model, default 40) bounds a runaway loop — it is not a judgement
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

**A tool-call turn may contain visible assistant text too.** Models often narrate
the next action (for example, "Now the docs...") in `content` before emitting
`tool_calls`. That text is not reasoning and is not disposable stream chrome.
`StreamedAssistantTurn.completeToolCall()` must retain the sanitized assistant
content on the same protocol message; use `content: null` only when the round
actually emitted no visible text. Otherwise the commentary appears live, then
vanishes on the next transcript sync while the final summary misleadingly
survives. Regression coverage lives in `ToolCallingLoopReasoning.test.ts` and
`sessionTypes.test.ts`.

**`src/templates/builtin/` is DEAD.** `TemplateEngine` loads
`config/templates/builtin/` (see `extension.ts`). The two copies have diverged.
