# `/new <n>` goes silent when the target workspace is already open

**Status: implemented 2026-09-04.** What shipped is recorded at the bottom.

**Observed:** 2026-09-04 17:25 local, Telegram chat `8997111571`.
`/new 15` (Ssuno → Forge) answered "switching to Forge… I will message you
when it is back", then nothing. Two `/status` messages at 17:27 and 17:28 were
never answered. The bot was dead until a window was reloaded by hand.

## What actually happened

Evidence, all from the machine that ran it:

| Fact | Source |
| --- | --- |
| Handoff was recorded correctly, target id `5f7df423…` = `n:\vs code apps\Forge` | `remote-state-v2.json`; `workspaceIdFor()` reproduces the hash |
| It is **still `state: "pending"`** — nobody ever claimed it | same file |
| The lease directory is **empty** — no window owns Telegram | `globalStorage/efsoo.forge-llm/remote-leases/` |
| The source window (Ssuno, window1) **never reloaded**: webview heartbeats run unbroken from 12:00 through 17:30, and its remote-status chip ticks once at 17:26 (transports going away) and never again | `window1/…/1-Forge.log` |
| No extension host exited after 17:20:55 | `main.log` |
| `n:\vs code apps\Forge` was **already open in two other windows** (window5, window6 — window6 re-activated 17:21:02) | `workspaceStorage/e9a4155d…/workspace.json` per window |

So: `RemoteRuntime.handoff()` recorded the departure, called
`manager.stopActive()` (releasing the Telegram lease), then called
`vscode.openFolder(target, false)` — which **focused the window that already
had that folder open instead of reloading this one**. `openFolder` resolved
successfully, so nothing surfaced locally either.

The already-open target window never re-activates, and
`resumeWorkspaceHandoffs()` only runs inside `RemoteRuntime.replace()` — i.e.
at activation or a config apply. Nothing polls for a handoff that arrives while
a window is already up. Meanwhile the source has given up the lease. Result:
zero windows polling Telegram, a pending handoff that expires unclaimed five
minutes later, and a chat with no way back in.

This is not the workspace-id bug the 2026-09-04 audit closed — the ids match
exactly. It is a lifecycle gap: the protocol assumes the target window is
always *starting*.

## Fix

### 1. The target window claims a handoff while it is already running

`RemoteRuntime` watches the durable store for handoffs addressed to its own
`workspaceId` and claims them without a restart.

- Watch the store directory (the file is replaced by rename, so a file watch
  misses it) plus a slow interval as a backstop.
- On a pending handoff for this workspace, run the existing
  `resumeWorkspaceHandoffs()` → bind → `announceWorkspaceArrivals()` path
  unchanged, and start the transports if none are active (the source has by
  then released the lease; retry briefly if it has not).
- No TOTP wording change: an already-running window did not reload, so the
  session is *not* locked. `announceWorkspaceArrivals` takes the lock state
  from `totpEnrolled()`, which would say "locked" wrongly here — pass the
  reason for the arrival (`reload` vs `live`) and word the receipt from that.

### 2. The source window rolls back a switch that did not happen

After `openWorkspace()` resolves, the source window may still be alive. Give
the target a window to claim (~10 s), then re-read the record:

- claimed → the target took over; do nothing (this window is about to reload,
  or the target was already open and is now serving).
- still pending → the switch did not happen. Mark the handoff cancelled,
  restart this window's transports, and tell the chat plainly: the target is
  already open in another window and now serves it, or the switch failed and
  you are still in `<source>`.

Rolling back is what turns a silent death into a message. It also covers any
other reason `openFolder` fails to reload (a modal blocking the reload, a
folder that has moved).

### 3. Test coverage

- `RemoteWorkspaceHandoff.test.ts`: a live claim binds and announces without an
  activation, and the receipt does not claim the session is locked.
- A runtime test where `openWorkspace` resolves without the process ending:
  the handoff ends `cancelled`, transports come back, and the chat is told.
- A test that two windows cannot both claim the same handoff (the store's
  serialized mutation already guarantees this — pin it).

## Immediate recovery (no code)

Reload any window that has Forge's config — the binding still points at the
Ssuno workspace, so reloading the **Ssuno** window restores the chat exactly as
it was. The 17:25 handoff expired at 17:31 and cannot be claimed now.

## What shipped

Both halves, plus one thing the plan did not foresee.

- `RemoteHandoffCoordinator` (new) — polls the shared state file, gated on its
  mtime so an idle window does no work and the busy one does not reparse the
  document every tick. On a handoff addressed here it claims through the
  runtime; it also owns the source-side rollback timer.
- `RemoteRuntime.claimArrivals()` — **takes the transport lease before claiming
  the record.** The plan did not say this and it matters: the lease is the only
  cross-process mutex there is, so letting it decide is what stops two windows
  on the same folder from both binding the chat. A window that cannot take the
  lease leaves the record pending, which is precisely what the source window's
  rollback then acts on. It retries the lease for ten seconds, because the
  source releasing and the target acquiring are two processes.
- `requestedConfig` — kept separately from `appliedConfig`. In the incident the
  target window's startup *threw* on the contended lease, so it had no config to
  start from later. The watch now starts before transport startup for the same
  reason: the window that loses the lease race is exactly the one that must
  still be able to claim.
- `RemoteRuntime.switchWorkspace()` is public, arms the rollback before calling
  `openWorkspace`, and rolls back immediately if that call throws.
- `RemoteRequestStore.refresh()` and reload-then-mutate on the claim and
  rollback paths. `persist()` writes the whole document, so a window that sat
  idle while another wrote would otherwise revert the other window's work.
- `remoteStateFile.ts` (new) — the atomic write, with a bounded retry on
  Windows `EPERM`. **A rename over a file another process has open for reading
  fails on Windows**, and every window now reads this file on a timer, so an
  overlap that used to be exotic is ordinary. This surfaced as a flaky test
  first; it would have surfaced as lost remote state in production.
- Handoff record transitions moved to `RemoteHandoffState.ts` and the v1→v2
  migration to `RemoteStoreSchemas.ts`: the store was already at the 500-line
  cap.

Coverage is in `test/unit/RemoteHandoffAcrossWindows.test.ts`, driving two
`RemoteRequestStore` instances over one file — which is all a second VS Code
window is here. The three regression tests fail against the old runtime
(verified by disabling the watch and the rollback arming).
