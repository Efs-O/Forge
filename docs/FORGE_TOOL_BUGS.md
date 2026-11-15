# Forge tool faults

One entry per fault an agent hit in a Forge tool while working. **Recording is not fixing**:
log it, work around it, keep going. The once-a-week look reads this file together with the
daily session-log scan report and decides what to fix, in what order.

The split from `docs/AGENT_TOOL_TRAPS.md`: that file keeps the root-cause post-mortems for
faults already fixed in a release. This one is the live queue — open, by-design, and
wont-fix, all here, each marked.

Entry shape (copy it, fill it, newest entry last):

```
## <short symptom>
- Seen: <YYYY-MM-DD>, Forge <version>, chat <chat-id or "unknown">
- Tool: <tool name, and the argument that triggered it>
- Did: <what came back, quoted from the result, not reworded>
- Should: <what it should have done>
- Workaround: <what was done instead>
- Status: open | by design | wont fix | fixed in <commit or version>
```

---

## `format_file` re-indents a whole file instead of using the repo's formatter

- Seen: 2026-11-09, Forge 0.17.17x, lab chat (tool-lab round)
- Tool: `format_file` on `src/tools/gitReadTools.ts` and its test
- Did: `Formatted: src/tools/gitReadTools.ts` — then 328 and 349 changed lines respectively,
  every line re-indented to 4 spaces
- Should: apply the repository's own Prettier config (2 spaces), or refuse when it cannot
- Workaround: `restore_file` both paths from HEAD, re-apply the edit by hand, gate
  formatting with `npx prettier --check <files>`
- Status: open

## The first `code_intel` call of a session answers nothing while the language server loads

- Seen: 2026-11-09, Forge 0.17.171, lab chat
- Tool: `code_intel` `document_symbols` on `src/tools/gitReadTools.ts`
- Did: `No symbol provider answered for src/tools/gitReadTools.ts. The language server may
  still be starting` — and an immediate retry answered in full
- Should: wait for the provider, or say "warming" rather than reading as "this file has no
  symbols"
- Workaround: retry once before falling back to whole-file reads
- Status: open

## A still-loading server's `references` list is short and says so only in a note

- Seen: 2026-11-09, Forge 0.17.171, lab chat
- Tool: `code_intel` `references` for `makeGitBlameTool`
- Did: `Note: a text search also finds makeGitBlameTool in 1 file(s) the language server did
  not report: test/unit/GitReadToolCap.test.ts.`
- Should: return the complete set, or name the files it could not check
- Workaround: cross-check with `grep_search` before naming the tests that cover a tool
- Status: open

## "No diagnostics found" can be the pre-edit check

- Seen: 2026-11-09, Forge 0.17.17x, lab chat
- Tool: `code_intel` `diagnostics` right after an `edit_file`
- Did: `VS Code reported no new check of src/tools/gitReadTool.ts in the 4 s after Forge's
  edit, so these diagnostics may predate it. No diagnostics found.`
- Should: not answer until a post-edit check exists, or block until one lands
- Workaround: treat it as unknown; gate with the project's own command in the same round
- Status: open

## A glob under `~/.forge/` was not refused where the rule says it should be

- Seen: 2026-11-14, Forge 0.17.17x, lab chat
- Tool: `shell` — `ls ~/.forge/logs/*`
- Did: no refusal; `ls: cannot access '/c/Users/…/.forge/logs/*': No such file or directory`
  (exit 2), while `ls ~/.forge/jobs/*` in the same round listed 40+ paths
- Should: the read/write guard's stance on `~/.forge` paths should be the same for a matching
  and a non-matching glob, and stated in the message
- Workaround: pass the absolute path to `list_directory`
- Status: open

## `wait` returns instantly when a background notice lands, and reads like a held sleep

- Seen: 2026-11-13, lab chat
- Tool: `wait` `seconds: 20`
- Did: `Wait ended after 0s of the 20s requested because a new message arrived.`
- Should: same as now (returning early is correct) — but the trap is reading the call as a
  sleep
- Workaround: read the `ended after Ns` part before concluding it held
- Status: by design

## `stop_execution` on a job that already finished reports the job's own exit code

- Seen: 2026-11-13, lab chat
- Tool: `stop_execution` on a `vitest run test/unit` that had ended in the previous round
- Did: `{"status":"failed","exit_code":1}`, and the completion notice said
  `failed (exit 1) after 1m 24s` — read as "my stop worked"
- Should: the result should say whether the stop terminated anything
- Workaround: check `status` is `terminated` (with `exit_code: null`) before claiming an
  interruption
- Status: open

## `git_read` blame repeats the full header for every line

- Seen: 2026-11-09, lab chat
- Tool: `git_read` `blame`, lines 149-176 of a 230-line file
- Did: `--line-porcelain` repeated the author/committer header per line, so 28 lines came
  back as ~250 lines of text
- Should: default to a compact form and offer the full header on request
- Workaround: ask shell for `git log -L <start>,<end>:<file>`
- Status: open

## `shell` refuses a `timeout_ms` above 600000 even for a background job

- Seen: 2026-11-13, lab chat
- Tool: `shell` `timeout_ms: 900000`, `background: true`
- Did: `"timeout_ms" must be within 1000 to 600000. Resend it in that range.` — no job started
- Should: as now; a background job does not need a long foreground ceiling
- Workaround: `background: true` with the default, then `monitor_execution`
- Status: by design
