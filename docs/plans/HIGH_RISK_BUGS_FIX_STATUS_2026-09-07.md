# High-risk report follow-up — 2026-09-07

Source report: [HIGH_RISK_BUGS_2026-09-05.md](HIGH_RISK_BUGS_2026-09-05.md).

## Implemented

- **#1:** Config replacement renames over the destination without first deleting
  it. A failed rename preserves the live config and removes the temporary file.
  The existing backup behavior remains. This fixes the missing-file window;
  it does not promise power-loss durability through filesystem caches.
- **#4:** Windows shutdown runs taskkill against the intact parent process tree,
  checks its result, and rejects on failure or timeout. POSIX shutdown rejects
  on timeout and cancels its escalation timer when the process exits.
- **#5/#15:** Failed eviction or release no longer permits replacement startup
  or frees the occupied port. Drivers retain process ownership for retry, and
  failed eviction restores the previous slot. Startup/restart cleanup failures
  retain their slots as well.
- **#8:** Recursive-delete detection recognizes Windows wrapper suffixes in raw
  terminal commands. This closes the matching inconsistency; it does not turn
  the command denylist into a shell sandbox.
- **#13, partial:** Temporary-file cleanup now also covers a failed initial write.
  Abrupt process termination can still leave temporary files.
- **#18:** WhatsApp unlink, transport removal, and unpairing execute together in
  the runtime lifecycle queue, preventing interleaving with configuration changes.

## Deliberately unchanged / unresolved

- **#2/#3:** Absolute paths are an explicitly documented file-tool capability,
  subject to the existing tool permission system. Enforcing workspace-only paths
  would change that capability. No new path restriction was introduced.
- **#6/#9/#10/#12/#16/#17:** The failure scenarios are not established by the
  report; see the review discussion. No speculative behavior changes were made.
- **#7/#14:** Cross-process lease recovery/release races remain unresolved.
  Raising the stale timeout does not fix atomicity. A follow-up needs a portable
  cross-process locking/fencing design and competing-process regression tests.
- **#11:** A handler-side size check cannot prevent upstream generation
  truncation. Existing chunk guidance and generation recovery remain in place.
- **#13:** No automatic stale-temp sweep was added: age alone does not establish
  that another process has stopped using a temporary file.

## Verification and concurrent work

Regression coverage includes config rename failure, eviction/release failure,
process-tree shutdown outcomes, wrapper detection, and unlink/config ordering.
The full test run passed: 1,940 tests, with 18 skipped.

Other implementation work was active in the same checkout. Sidebar/webview and
remote-progress edits belonging to that work were preserved. The first CI run
encountered file-size lint errors in `src/sidebar/messageBridge.ts` and
`webview-ui/src/App.tsx`; these were not edited as part of this fix set.
