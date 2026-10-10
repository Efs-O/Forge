# Temp-folder leak plan

## Problem

`%TEMP%` on the dev machine held **16,683 `forge-*` folders (1.2 GB)** on 2026-10-10, back to 2026-08-12.
Nothing failed, so nothing told anyone: every leaked folder was created by a passing test that never
removed it. About 101 prefixes leak; the largest:

| prefix | folders | source |
|---|---:|---|
| `forge-attachments` | 3,525 | `ChatAttachmentStore.test.ts` |
| `forge-fake-cli` | 1,961 | `AgentLoop`, `CliDelegationReplyContract`, `LocalDelegationServiceCli` tests |
| `forge-slog` / `forge-suse` / `forge-slr` / `forge-ste` | 5,866 | `SessionLogger{Reasoning,Usage,Resume,TurnError}` tests |
| `forge-checkpoints-<pid>` | 1,674 | `new CheckpointStack()` with no `storageRoot` in tests (the extension always passes `globalStorage/checkpoints` via `checkpointSetup.ts`) |
| `forge-voice-audit` | 1,398 | `RemoteVoiceBridge` tests |
| `forge-forensics`, `forge-contact-*`, `forge-jobs-own`, `forge-remote-*`, `forge-process-tools`, … | ~800 | one test file each |
| `forge-shell-kill` | 26 | the kill test's cleanup lost an EPERM race (fixed in 49997a3) |

The byte total is dominated by three one-off folders from manual sessions (`forge-docker-install` 596 MB,
`forge-llama-b10733-*` 516 MB, `forge-copilot-acp-spike` 14 MB) and loose `forge-llm-*.vsix` copies. No current
source creates them. `forge-sps`, `forge-tell-test` and `forge-run-build` have no matching source today. Their
newest folders date from 2026-09-29 to 10-07, so the tests that made them were renamed or fixed.

Runtime code does not leak here. `atomicWrite.ts` writes its temp file beside the target, and the
`forge-${id}` in `benchmark/evaluator.ts` is a SWE-bench run id, not a folder.

## Fix

1. **One-time cleanup.** Delete `%TEMP%\forge-*` entries older than one day. Run it while no Forge CI or VS Code
   test host is running. Skip any entry that fails to delete (that means it is in use) and report it.
2. **Contain every run.** A vitest `globalSetup` (`test/support/tempGuard.global.ts`) creates
   `os.tmpdir()/forge-test-run-<pid>-<random>` before the workers start and points `TEMP`/`TMP` (Windows) or
   `TMPDIR` at it. Workers and their children inherit the variables, and `os.tmpdir()` reads them on every call.
   Teardown deletes the folder with retries, so a just-killed child's cwd cannot fail it, and restores the
   variables. Setup also deletes sibling `forge-test-run-*` folders whose pid is not alive (a killed run).
   From this commit on, a test run cannot add to the pile, whatever the tests do.
3. **Make leaks fail, per test file.** A `setupFiles` entry (`test/support/tempGuard.setup.ts`) runs before
   each test file is imported. It gives that file its own subfolder of the run folder and points the variables
   at it. Its `afterAll` runs after the file's own hooks and lists what the file left there. A file that left
   anything fails, and the error names the file and the entries. Two names are ignored because programs the
   tests start create them, not Forge code: `node-compile-cache` (Node's shared compile cache) and
   `chrome_*url_fetcher*` (Chrome's own scratch folder).
   *Changed from the first draft:* a baseline file listing the known leakers was dropped. Only 13 files leaked,
   so step 4 fixes all of them in the same commit and there is nothing to list.
   *Changed from the first draft:* grouping leftovers by name prefix was dropped. `mkdtemp`'s random six-character
   tail cannot be told apart from a real name part, so the same leak would sometimes get a new key and fail CI at
   random. A test file path is a stable key, it names the culprit directly, and the per-file check works in a
   filtered run as well as a full one, so there is no full-run detection.
4. **Fix the leakers, biggest first.** Add `afterEach`/`finally` cleanup in each file, or give
   `new CheckpointStack()` a test-owned `storageRoot`, or dispose a service whose timer would write after the
   test's folder is gone.
   Never weaken an assertion to make cleanup easier.

Not in scope: changing `CheckpointStack`'s default `storageRoot`. Production never uses the default, and
removing it would touch every test that constructs one. If it is removed later, that is a separate change.

## State × lifecycle ledger

| artifact | create | delete | pause/disable | crash mid-write | owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| run folder `forge-test-run-<pid>-<rand>` and its per-file subfolders | globalSetup, before workers; a subfolder per test file in setupFiles | teardown, recursive with retries; each subfolder in the file's `afterAll` | n/a: there is no switch; it exists only during a vitest run | partial content is deleted with the folder at teardown | vitest killed: the folder survives; the next run's setup deletes sibling `forge-test-run-*` folders whose pid is not alive | none needed beyond the dead-pid sweep at setup |
| env overrides `TEMP`/`TMP`/`TMPDIR` | globalSetup (run folder); setupFiles (per file, inside a worker) | teardown restores the saved values; a worker's values die with it | n/a | n/a: in memory only | they die with the process | n/a |

CI-enforced row: the run folder's per-file subfolders. A test file that leaves anything in its subfolder fails
`npm run ci`. `test/unit/TempGuard.test.ts` checks that `os.tmpdir()` inside a test is the file's guarded folder,
so a vitest upgrade that stops workers inheriting the variables fails instead of silently disabling the guard.

## Acceptance criteria

- `%TEMP%` has no `forge-*` entry older than one day after the cleanup, apart from in-use folders, which are listed.
- Two back-to-back `npm run ci` runs leave `%TEMP%` with the same `forge-*` entries before and after
  (the guard's own run folder included).
- A deliberately leaking test (`mkdtempSync` with no cleanup, prefix `forge-leakprobe-`) fails that file and
  names it and the leftover entry. Delete the probe afterwards.
- Killing vitest mid-run leaves one `forge-test-run-*` folder, and the next run removes it.
- `npm run ci` passes with no leaking test file, and `docs/OWNERS.md` names the two `test/support/tempGuard.*` files.
