# Commit audit — 2026-10-03 (Europe/Athens), branch `master`

Baseline: `7da37b5` (2026-10-02 19:29) → `be4152c` (HEAD, 2026-10-03 15:13).
16 commits in range. Times from `git log --date=format-local` with `TZ=Europe/Athens`.
Working tree at audit time: 21 modified tracked files (an unrelated in-progress
external-server feature) + 4 untracked paths. Those uncommitted changes are
**outside** the commit-audit scope and are called out in §5.

## 1. Commit list

| # | hash | local time | subject |
|---|---|---|---|
| 1 | `74cbfb5` | 00:01 | fix(codex): apply codex_model/codex_effort on thread/resume (0.16.76) |
| 2 | `2e9304d` | 00:36 | feat(notify): deliverFile with a shared per-turn file budget |
| 3 | `35389c7` | 00:47 | fix(notify): drain the conversation-less budget; correct the exemption comment |
| 4 | `9b4f18b` | 01:06 | feat(tools): send_file — deliver any file to the watching remote chat |
| 5 | `12800cd` | 04:38 | feat(tools): render_html_to_image — render HTML/CSS/SVG to a PNG and queue it |
| 6 | `8585e33` | 07:41 | fix(unload): declare control POST as JSON so Strata's /unload is not 415'd |
| 7 | `6a2b8b6` | 07:45 | Allow search_code outside workspace |
| 8 | `6dba0be` | 08:28 | feat(external): start_command — Forge launches a managed server before a request |
| 9 | `74c570f` | 08:39 | docs(plan): record the 0.16.77 live smokes run from a real bound-chat turn |
| 10 | `1a939ad` | 11:03 | fix: add bounded recovery hints for invalid tool calls |
| 11 | `2f4af71` | 11:09 | docs: record 0.16.78 notes and image delivery budget plan |
| 12 | `4aa3f85` | 11:53 | Budget image search and unconfirmed image delivery |
| 13 | `834bc64` | 14:18 | feat(image_search): make yandex the default engine, Lens the opt-in |
| 14 | `ce17884` | 14:23 | chore(release): 0.16.79 — record the yandex-default change |
| 15 | `f97ac21` | 14:30 | feat(external): resolve {num_ctx} in start_command from the model config |
| 16 | `be4152c` | 15:13 | fix(tools): refuse array entries that are not objects |

## 2. Findings

### F1 — HIGH — `search_code` with an absolute include drops every exclusion
Introduced today (`6a2b8b6`).
`src/tools/searchScope.ts:96-101` returns `explicitPath: true` for **any** absolute
include without a wildcard — including the workspace root itself.
`src/tools/dirTools.ts:326-328` then emits `--no-ignore-vcs` and **no**
`SEARCH_EXCLUDES` globs at all:

```ts
...(scope.explicitPath
  ? ['--no-ignore-vcs']
  : ['--glob', scope.glob ?? include, ...SEARCH_EXCLUDES.flatMap((g) => ['--glob', g])]),
```

Failure scenario: an agent types `include: "N:\vs code apps\Forge"` (now actively
encouraged by the new tool description at `dirTools.ts:234,243-245`). ripgrep
crawls `node_modules/`, `dist/`, `out/`, `.git/` and
`.forge/embeddings.index.json` — the exact file `SEARCH_EXCLUDES` exists to
suppress, and the exact failure documented at `dirTools.ts:12-21` ("the tool
looked broken while working") and in `docs/plans/TOKEN_EFFICIENCY_PLAN.md:56-60`.
Verified live in this session: `search_code include="N:\vs code apps\Forge"`
returned `N:/vs code apps/Forge/node_modules/vitest/package.json`;
`include="N:\vs code apps\Forge\*"` returned matches from
`.forge/embeddings.index.json`. The relative branch does not have this hole.

Second half of the same branch: a wildcard in the **first** segment of an
absolute include makes the rg root the drive. Verified: `N:\*` →
`{target: "N:\\", glob: "*"}`, `C:\*` → `{target: "C:\\", glob: "*"}` — a
whole-drive `--hidden` crawl.

Evidence the exclusions are untested on this path: `test/unit/SearchCodeExcludes.test.ts`
asserts only the shape returned by `resolveSearchCodeScope`; the two new
integration tests in `test/integration/SearchCodeExecution.test.ts` drive
`test/fixtures/fake-rg.mjs`, which ignores the glob args entirely.

Suggested fix: keep the exclusion list on every branch (only the *ignore-vcs*
rule is what "the caller named it" should override), and refuse a derived rg
root that is a drive root or above a sane depth.

### F2 — HIGH — `ensureStarted` has no in-flight guard; concurrent requests spawn the server twice
Introduced today (`6dba0be`, refined `f97ac21`).
`src/backend/ExternalModelServers.ts:193-212`: probe → `launchStart` → poll up to
`START_TIMEOUT_MS` (240 s). Nothing records that a start is already running, and
no test covers it (`test/unit/ExternalModelServers.test.ts:329-446` has no
concurrency case for `ensureStarted`).

`ensureStarted` is reached from `resolveCloudRequestTarget`
(`src/llm/CloudRequestResolver.ts:33`), which has five call sites:
`ProviderTurn.ts:98`, `PromptRun.ts:143`, `ControlChatProxy.ts:78`,
`LocalDelegationService.ts:200`, `imageGeneration/cloudImageBackend.ts:47`.

Failure scenario: a chat turn and a delegation (or an `generate_image` call, or a
second tab) hit the managed model while it is down. Both probe "not reachable",
both spawn `start_command`. With this machine's config
(`.forge/config.yaml:730`: `start_command: ["wscript.exe","N:/Strata/start-strata-hidden.vbs","{num_ctx}"]`)
that is two Strata launches racing for the same port and loading a 192 k-context
model into VRAM twice; the loser then sits in `waitReachable` for up to 240 s and
reports "started but did not become reachable". A leaked, half-started server is
the visible outcome, and nothing reaps it.

Suggested fix: one in-flight `Promise` per model name (`.set` before awaiting,
cleared in `finally`), so concurrent callers join the same start.

### F3 — MEDIUM — the registry refusal pre-empts the tool-owned message its own comment says it must not
Introduced today (`be4152c`).
`src/tools/ToolRegistry.ts:113-117` states: "tools that own a nested structure
(`apply_line_edits`) already refuse with an operation-numbered message that beats
anything generic here, and a refusal raised at the registry would pre-empt the
better one." But `invalidArgs` runs **before** the handler
(`src/sidebar/ToolDispatch.ts:225`, handler at `:293`), and `invalidArrayItems`
fires for exactly `operations: ["..."]`. Probe run confirmed:

```
REGISTRY SAYS: "Error: apply_line_edits \"operations\" entries must be objects, not entry 1 (string). …"
```

So `structuredEditTool.ts:176-178` (`operation N must be an object`) is
unreachable through normal dispatch, and the comment describes the opposite of
the shipped behaviour. The registry message also loses the operation index
semantics the tool message carries.

Suggested fix: skip `invalidArrayItems` for tools that declare they own the
nested check (or let the handler's throw win by only running the generic check
when the handler produced no message), and correct the comment.

### F4 — MEDIUM — absolute `search_code` has no scope allowlist, contradicting the plan it cites
Introduced today (`6a2b8b6`), as a policy violation; the read-anywhere *capability*
is pre-existing (`read_file` reads anywhere).
`namedExistingPath` refuses to escape the workspace (`searchScope.ts:62-66`); the
new absolute branch has no allowlist — no `extra_file_roots`, no depth limit.
`docs/SAFE_WORKER_TOOL_UPGRADE_PLAN.md:237` still reads "Glob scopes cannot
escape or enumerate outside the workspace" while the same commit amended only
line 411 to permit it. The doc now contradicts itself, and the worker plan's
policy requirement is unmet by the shared implementation.

### F5 — LOW/MEDIUM — `codePoints.ts` shipped with no production caller; the caption trim still splits surrogate pairs
Introduced today (`12800cd`), for the drift; the trim itself is pre-existing.
`src/util/codePoints.ts` declares itself "the single owner of that distinction"
and says anything enforcing or trimming a character limit "should use it rather
than re-deriving the iteration". `sliceCodePoints` has zero production callers
(grep: only `src/util/codePoints.ts` and `test/unit/CodePoints.test.ts`).
`src/remote/TelegramPhoto.ts:50` still does `caption.slice(0, MAX_CAPTION_CHARS)`.
`sendFileTool.ts:113-118` now *validates* the caption in code points, so the
guard and the trim disagree exactly as the module's header warns.
Demonstrated: a 1024-code-point emoji caption (2047 UTF-16 units) passes the
guard, and `.slice(0,1024)` cuts a pair — the tail encodes as `efbfbd efbfbd`
(two U+FFFD).

### F6 — LOW — `image_search` now hard-errors on a `type` argument that used to be valid with the default engine
Introduced today (`834bc64`). `imageSearchTool.ts:127-128` throws when
`engine === 'yandex' && args['type'] !== undefined`. `yandex` is now the default,
so every caller that relied on the previous default plus `type` gets a refusal
instead of a search. Behaviour change, not a crash; worth a deliberate decision.

### F7 — LOW — unreachable defensive branch in `render_html_to_image`
Introduced today (`12800cd`). `renderHtmlToImageTool.ts:171-177` calls
`deps.notifications.remainingFileDeliveries?.(...)` and tests
`remaining !== undefined`. `notifications` is a required
`UserNotificationService` and `remainingFileDeliveries` is a real method, so the
optional chain and the `undefined` arm are dead in production.

### F8 — MEDIUM — `codePointLength` under-counts line terminators
Introduced today (`12800cd`); found while fixing F5, so it is recorded here
rather than in the original pass. `src/util/codePoints.ts` counted characters with
`text.match(/./gu)?.length`, but `.` with the `u` flag never matches a line
terminator: `codePointLength('a\nb')` returned 2, not 3. The function gates
`send_file`'s caption (`sendFileTool.ts:113-118`), so a caption containing
newlines could be up to one line short of the limit it was refused for — a
multi-line 1,024-code-point caption passed a guard it should have failed.
Verified with a `node` probe: `a\nb -> 2`.

## 3. Checked and found sound (do not re-litigate)

- `send_file` screenshot-directory isolation: `resolveFilePath` requires a *real
  direct child* (`sendFileTool.ts:44-52`), which is what closes the
  `conv-a → conv-b` junction escape; the case-insensitive `default` guard is
  correct for Windows/macOS.
- `render_html_to_image` browser lifecycle (`renderEngine.ts:96-126, 220-224`):
  handle taken before awaiting, one named abort listener, `giveUp` flag so a
  launch resolving after the deadline still gets closed. Network is closed twice
  over (`context.route` + `--host-resolver-rules=MAP * ~NOTFOUND`), JS disabled,
  `setContent` only — no `file://`.
- Output-name claim (`claimUniquePath`, `:292-314`) is an `O_EXCL` sidecar, so it
  holds across processes; the abandoned sidecar is bounded because the stamp has
  one-second granularity (verified: `20261003-213015`).
- File-delivery budget: charge and check in one method, lease invalidated by
  `resetTurn` (`UserNotificationService.ts:227-252`), no idle refill by design,
  `NO_CONVERSATION` bucket drained unconditionally (`extension.ts:251-257`).
  `image_search` charges one slot per thumbnail and reports the withheld count.
- `PromptRun.ts:211` fires `onGenerationStarted` without a conversationId —
  deliberate, and documented at `sessionTimerWiring.ts:25`.
- `web_fetch` SSRF: `fetchTool.ts:1` imports `dns/promises` lookup and pins the
  resolved address; the earlier lexical-only concern from a previous round is
  fixed and is **not** re-reported here.
- `unload` 415 fix (`8585e33`) is correct and tested.
- `{num_ctx}` resolution (`f97ac21`) validates before spawning and names the
  model; `mergeGroupsIntoModel` gives `launchStart` the flattened value.

## 4. Checks run

| Check | Result |
|---|---|
| `git log --date=format-local` with `TZ=Europe/Athens` | 16 commits in range, listed above |
| `git diff --check HEAD~16 HEAD` | clean, exit 0 |
| `git show` of every changed source file in `6a2b8b6`, `12800cd`, `9b4f18b`, `4aa3f85`, `834bc64`, `f97ac21`, `be4152c`, `1a939ad`, `2e9304d`, `35389c7`, `8585e33`, `6dba0be` | read in full |
| `npx vitest run SearchCodeExcludes ToolSchemaBudget ToolCallRefusalMessages CodePoints SendFileTool UserNotification` | 6 files, 89 tests passed |
| `npx eslint` on the five new/heavily-changed tool files | clean, exit 0 |
| Live `search_code` probes for F1 | node_modules and embeddings index matches confirmed |
| `node` probes for `N:\*` / `C:\*` scope derivation, UNC roots, caption surrogate split, stamp granularity | as quoted |
| `git grep` for `sliceCodePoints`, `ensureStarted`, `resetTurn`, `invalidArgs`, `no-ignore-vcs`, `mustBeInsideWorkspace`, `dns` | as quoted |

## 5. Not verified / out of scope

- **`npm run ci` was not run.** The tree already carries 21 modified tracked
  files and 4 untracked paths from an unrelated in-progress change
  (`src/backend/poolReadiness.ts`, `src/sidebar/*`, `webview-ui/src/slashCommands.ts`,
  remote unload commands). Running CI now would not attribute failures cleanly.
  Any fix in this report must be CI-verified against the tree state it lands in.
- `rg --version` is unavailable in this tool environment, so F1 was proven
  through the tool's own output rather than by invoking `rg` directly.
- Runtime behaviour of `render_html_to_image` (real Chrome launch) and of the
  Strata `start_command` was not exercised; F2 is a code-path race, not a
  reproduced crash.
- `test/live` and `test/integration` beyond `SearchCodeExecution` were not run.


## 6. Codex review verdicts (2026-10-03, live `codex` session, read-only)

Codex reviewed the report and the unstaged fixes and answered per finding:

| Finding | Codex verdict | Follow-up it asked for |
|---|---|---|
| F1 | CONFIRMED, fix correct | add a real-ripgrep check (excluded dir + a deliberately named file inside it); the fixture only checked argv |
| F2 | CONFIRMED, guard correct | one test where *both* concurrent callers receive the failure, then a retry starts once |
| F3 | PARTLY | pre-emption is real, but the registry message is the better one (field + entry + type); comment-only fix accepted, keep the refusal order |
| F4 | PARTLY | no `extra_file_roots` allowlist required, but the docs fix was incomplete — lines 236 and 244 still said *all* paths/results are workspace-relative |
| F5 | CONFIRMED, fix correct | add a FormData caption test at the 1,024-code-point emoji boundary |
| F6 | CONFIRMED as deliberate | no code change if the decision stands |
| F7 | CONFIRMED | `remaining !== undefined` is still dead — simplify to `remaining <= 0` |
| F8 | CONFIRMED, fix correct | add newline and 1,024/1,025-code-point boundary tests |

Separate note from Codex (informational, not a finding): a bare `rg` through
`exec_command` fails on this machine because that path does not resolve the
VS Code-bundled binary. Verified here: no `rg.exe` under `node_modules`, and the
bundled one lives at `<install>/<commitHash>/resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/win32-x64/rg.exe` —
the candidate list `src/tools/RipgrepResolver.ts` already probes from
`vscode.env.appRoot`. That is the already-planned Phase 3 of
`docs/plans/COMPACTION_MEMORY_SEARCH_RECOVERY_PLAN.md`, a separate feature; it is
**not** part of this audit and is not implemented here. It does explain why F1
was proven through `search_code`'s own output rather than a direct `rg` call.

## 7. Fixes applied (all in the working tree, unstaged at report time)

| Finding | Code | Test |
|---|---|---|
| F1 | `searchScope.ts`: new `applyExcludes` on `SearchCodeScope`; new `rgScopeArgs()` as the single owner of the `--no-ignore-vcs` and exclusion decisions (exclusions kept on every branch except a named FILE; no `--glob <the named path>`, which would filter out the path itself); absolute glob whose static prefix is the drive root is refused. `dirTools.ts` calls `rgScopeArgs(scope)` | `SearchCodeExcludes.test.ts`: 7 `rgScopeArgs` cases + drive-root refusal + named-directory stat; `fake-rg.mjs` gained an `args fixture` that echoes the scope-relevant argv (the old fixture ignored them, which is how the bug passed its own test); `SearchCodeExecution.test.ts`: 2 argv-level integration tests **and** a `describe.skipIf` block against the real bundled ripgrep (excluded dirs omitted for a named root, a deliberately named file inside `dist/` still searched, relative glob still excluded) |
| F2 | `ExternalModelServers.ts`: `starting` map of in-flight starts; `ensureStarted` joins an existing start, `startOnce` does the work, `finally` drops only its own entry | 3 tests: join-one-spawn, every joined caller receives the failure then one retry, retry-after-failure spawns again |
| F3 | `ToolRegistry.ts` comment corrected to describe the shipped precedence (registry refusal wins; the handler branch remains for `registry.dispatch` callers that skip the pre-check, e.g. `benchmark/toolHost.ts:331`, `contactWebTools.ts`) | existing `ToolCallRefusalMessages.test.ts` covers the message; no behaviour change |
| F4 | `docs/SAFE_WORKER_TOOL_UPGRADE_PLAN.md`: the glob-scope, path-input and result-path bullets now say the workspace-relative rule is the **worker** surface and that the main agent's `search_code` may name an absolute target, with whole-drive crawls refused | doc-only |
| F5 | `TelegramPhoto.ts` trims with `sliceCodePoints` | `RemoteImageDelivery.test.ts`: a 1,030-emoji caption posts exactly 1,024 code points with no lone surrogate, captured off the real `FormData` |
| F7 | `renderHtmlToImageTool.ts`: direct call, `remaining <= 0` | `renderHtmlRig.ts` always supplies the probe (default `FILE_DELIVERY_TURN_LIMIT`); `RenderHtmlLive.test.ts` and `RenderHtmlInputSizeRace.test.ts` rigs updated to the real service shape |
| F8 | `codePoints.ts`: `Array.from(text).length` | `CodePoints.test.ts`: `a\nb` = 3, `\r\n` = 2, and 1,024/1,025 boundaries for both a newline-bearing caption and an emoji caption |

Not changed, by decision: F6 (deliberate compatibility break, confirmed by
Codex), and the `exec_command` bare-`rg` resolution (separate planned feature).

## 8. Verification after the fixes

| Check | Result |
|---|---|
| `npx vitest run` on `CodePoints`, `SearchCodeExcludes`, `SearchCodeExecution`, `RemoteImageDelivery`, `RenderHtmlToImageTool`, `ExternalModelServers` | 6 files, 117 tests passed (the bundled-ripgrep block executed, not skipped) |
| Earlier combined run: `RenderHtmlOutputDelivery`, `RenderHtmlClaimAbort`, `RenderHtmlInputSizeRace`, `ToolCallRefusalMessages`, `SendFileTool`, `TelegramPhoto`-adjacent delivery | passed |
| `npm run ci` | exit 0 — `type-check`, `lint` (one prettier error in the `dirTools.ts` import, fixed with `--fix`), `npm test` 390 files / 4011 tests passed (40 skipped), `build`, `check:bundle` |
| `git diff --check` | clean |
| Codex round 2 | F1, F2, F3, F5, F7, F8 correct; F6 the recorded deliberate decision; F4 needed one more doc correction (worker-vs-main-agent scope in the glob bullet and the smoke case), applied and re-confirmed YES |
