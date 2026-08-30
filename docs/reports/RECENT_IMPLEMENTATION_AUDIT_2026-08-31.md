# Forge recent implementation audit

Date: 2026-08-31

## Result

The audited code is in better shape and both release gates pass. I found and
fixed seven product or maintenance problems. The most important one broke
Telegram approval buttons when TOTP was enabled. The second kept an active
Telegram connection on an old bot token after the user stored a replacement.

No feature was removed. Remote requests still use the normal Forge conversation,
agent, approval, checkpoint, and backend paths.

## What I reviewed

I used the latest 15 commits as the main boundary, from `2a97df4` through
`842db5f`. This covers the remote-control implementation, TOTP authentication,
Telegram attachments, conversation/model commands, workspace handoff, agent and
compaction progress, lease hardening, the recent timestamp fix, and the sidebar
activity-text change.

I also checked these six recent plans against the code:

1. `docs/plans/REMOTE_TOTP_AUTH_PLAN.md`
2. `docs/plans/REMOTE_AGENT_PROGRESS_PLAN.md`
3. `docs/plans/REMOTE_CONTROL_PLAN_V4.md`
4. `docs/plans/COMPACTION_SUMMARIZER_REQUEST_PLAN.md`
5. `docs/COMPACTION_PLAN.md`
6. `docs/REMOTE_COMPACT_PROGRESS_PLAN.md`

The review concentrated on authorization boundaries, provider limits, durable
state, hot reload, transport shutdown, progress truthfulness, duplicated config
logic, and user-facing documentation. I also ran the existing tests before
editing so that new failures could be separated from old ones.

## Findings and fixes

### 1. TOTP could break every Telegram approval button — fixed

Severity: high

Forge put the internal approval id and the TOTP session UUID together in
Telegram `callback_data`. A normal production approval id made the final value
longer than Telegram's 64-byte limit. The send could therefore fail when TOTP
was enabled, even though approvals worked without TOTP.

The provider now receives a short random handle. Forge keeps the real approval
id and auth nonce in memory, checks both on callback, and resolves the original
approval id. Telegram also rejects an oversized handle locally before making a
network request. This follows the official Telegram Bot API limit of 1–64 bytes:
https://core.telegram.org/bots/api#inlinekeyboardbutton

Changed:

- `src/remote/RemoteApprovalBridge.ts`
- `src/remote/TelegramChannel.ts`
- `test/unit/RemoteCore.test.ts`
- `test/unit/RemoteHardening.test.ts`
- `test/unit/TelegramChannel.test.ts`

### 2. Replacing the Telegram token did not replace the live token — fixed

Severity: high

The setup command wrote the new token to SecretStorage and called the ordinary
config reload. The runtime correctly keeps unchanged transports alive, but that
also meant the existing Telegram channel kept the old token captured at startup.
The UI said the new token was stored even though the active poller did not use it.

`RemoteRuntime.refreshTransport()` now serializes a targeted provider restart.
The token command uses it for Telegram. Other active transports remain running.
A regression test starts Telegram and WhatsApp, refreshes Telegram, and proves
that only Telegram is recreated.

Changed:

- `src/remote/RemoteRuntime.ts`
- `src/vscode/remoteCommands.ts`
- `test/unit/RemoteHardening.test.ts`

### 3. Failed and cancelled turns were shown as completed — fixed

Severity: medium

The queue drain always edited the live progress message to `Forge: completed.`
from a `finally` block. This happened for completed, cancelled, interrupted,
failed, and busy-requeued outcomes.

The drain now records the real outcome and ends the progress row as completed,
cancelled, failed, or queued. The durable final reply remains authoritative.
Regression tests cover completed, cancelled, and failed turns.

Changed:

- `src/remote/RemoteController.ts`
- `test/unit/RemoteCore.test.ts`

### 4. Telegram chunking could split an emoji in half — fixed

Severity: low

The 4,096-character splitter used JavaScript string indexes. Those indexes can
cut between the two UTF-16 halves of an emoji. The splitter now walks complete
Unicode code points and a boundary test proves the joined text is unchanged.

Changed:

- `src/remote/TelegramChannel.ts`
- `test/unit/TelegramChannel.test.ts`

### 5. Startup and hot-reload options were duplicated — fixed

Severity: maintenance risk

`RemoteRuntime` built the same `RemoteControllerOptions` object in two places.
That makes it easy for a future config field to work at startup but be forgotten
during an in-place reload. One `controllerOptions()` owner now serves both paths.
Transport startup was also extracted into one lifecycle method so ordinary
startup and credential refresh use the same lease, subscription, controller,
and cleanup rules.

Changed:

- `src/remote/RemoteRuntime.ts`

### 6. Recent remote documentation was stale — fixed

Severity: medium for setup, low for maintenance

The main guide listed only five old commands, omitted the authenticator flow,
used command names that did not match the extension manifest, and incorrectly
said pairing codes lived in SecretStorage. The separate TOTP guide also said a
new pairing was locked before any authenticator had been enrolled.

The guides now describe the real command surface, memory-only pairing/session
state, owner-bound TOTP, local enrollment, token refresh, timeout behavior, and
the exact Command Palette names. The validation guide now contains repeatable
TOTP checks. The two historical compaction plans are marked implemented, and
the ownership maps now name the canonical remote modules.

Changed:

- `README.md`
- `CHANGES.md`
- `AGENTS.md`
- `docs/OWNERS.md`
- `docs/REMOTE_CONTROL.md`
- `docs/REMOTE_CONTROL_VALIDATION.md`
- `docs/plans/REMOTE_TOTP_AUTH_SETUP.md`
- `docs/COMPACTION_PLAN.md`
- `docs/REMOTE_COMPACT_PROGRESS_PLAN.md`

### 7. The recent font-size fix ignored the VS Code font setting — fixed

Severity: low

The activity line had been changed from a relative size to a fixed 14px. That
looked consistent at the default setting but stopped following the user's VS
Code font size. It now stays one pixel above the configured editor font size.

Changed:

- `webview-ui/styles/animations.css`

## Areas checked with no further change needed

- TOTP secrets are owner-bound in SecretStorage. Session state, accepted steps,
  failure counts, and nonces remain memory-only.
- Locked sessions block commands, normal prompts, callbacks, queued-work drain,
  final notifications, and approval disclosure. Existing tests cover these
  boundaries.
- Telegram and WhatsApp serialize inbound events before the controller. This
  keeps gate decisions and state-changing routes ordered for each transport.
- Telegram advances its update cursor only after the controller returns a
  terminal disposition. Retry events remain replayable.
- The request store serializes mutations and writes a temporary file before an
  atomic rename. Crash-left running work becomes `unknown`, not replayed.
- The recent lease heartbeat change writes in place without a truncate window,
  waits for an active heartbeat during release, and never deletes a replacement
  lease. Existing focused tests cover all three cases.
- The filesystem timestamp-skew fix reads the clock after async stat calls and
  clamps only small negative ages. Its boundary test matches the implementation.
- Compaction start/finish events are emitted once around real work, remote-origin
  events are de-duplicated, and automatic notifications use the durable outbox.

## Repository cleanliness

The worktree initially had local model-quality data and probing scripts. They
contain machine-specific paths and are not product tests. I preserved them and
excluded their exact paths locally instead of deleting them or adding broad
shared ignore rules. One additional prompt-context measurement appeared during
the audit; it was preserved as local work and explains the extra test/time in
the full local CI run.

No tracked source changes were discarded. A concurrent `FORGE.md` note about
shell-free executable invocation was also preserved.

## Verification

Baseline before edits:

- `npm run ci`: passed
- 1,446 tests passed, 14 skipped

Focused verification after fixes:

- 46 Telegram/remote tests passed
- strict TypeScript check passed
- ESLint passed
- `git diff --check` passed

Final release verification:

- `npm run ci`: passed
  - 1,452 tests passed, 14 skipped
  - type-check passed
  - lint passed
  - extension and webview production builds passed
  - bundle-load smoke passed
- `npm run package`: passed
  - created `forge-llm-0.14.0.vsix`
  - 27 packaged files
  - 8.19 MB

The 1,452 total includes one preserved local measurement test. The product
regression suite gained five normal test cases in the three existing remote test
files.

## Remaining limits

These are documented limits, not regressions found in this audit:

- WhatsApp remains experimental and has not completed the real-device matrix.
- Real-device smoke for the newest live progress/compaction messages is still
  pending even though the automated paths pass.
- A host restart can lose an in-memory progress-message id or a compaction
  completion event emitted after a transport subscription is disposed. Already
  queued outbox items remain durable.
- Several older remote source files are above the preferred 350-line guideline.
  The duplicated runtime option/startup logic was removed, but splitting the
  command handler or durable store without a behavior goal would add migration
  risk and was not justified by a concrete defect in this pass.
