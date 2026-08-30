# Remote Agent Progress Streaming Plan

Status: implemented; automated gates passed; real-device Telegram smoke pending
Date: 2026-08-30
Scope: Telegram remote requests; transport-neutral host seam

## Goal

While a remote Forge request is running, replace the static `Forge: working…` line with
throttled updates containing the same visible assistant commentary and safe execution milestones
that appear in the VS Code transcript. The final answer continues through the durable outbox.

## Product contract

- Reuse the single progress message already created for a remote request.
- Edit that message at most once per throttle interval; never send one Telegram message per token.
- Include visible assistant text and bounded, sanitized tool/CLI status.
- Never forward hidden reasoning, raw tool arguments, secrets, approval payloads, or tool results.
- Keep progress ephemeral. Completion/failure notification durability remains owned by the outbox.
- Recheck remote authentication immediately before every edit. A locked TOTP session receives no
  transcript-derived progress.
- A sidebar-originated turn is not mirrored merely because its conversation is remotely bound.
  Only the controller currently executing a remote request may publish its progress.
- Failure to edit progress never fails or delays the agent request.

## Architecture

1. Add a typed `AgentProgressEvent` owned by the sidebar turn layer and addressed by conversation ID.
2. Extend `AgentLoop` with one listener set. `ModelTurn` emits visible token deltas and safe tool
   milestones; `CliTurn` emits visible text and CLI status. Reasoning callbacks remain separate and
   are never connected.
3. Expose an optional `ForgeHostFacade.onAgentProgress()` subscription alongside the existing
   compaction event seam.
4. Add a `RemoteAgentProgress` coalescer owned by each `RemoteController`. It tracks only active
   remote requests, accumulates a bounded preview, serializes edits, and throttles Telegram calls.
5. Start tracking after `sendProgress()` returns a message ID and stop it before the request leaves
   the controller drain. The normal durable final notification remains unchanged.

## Formatting

The edited message uses this shape:

```text
Forge: working…

I have read the request handler. Next I’ll update the binding logic.

Running read_file…
```

Only the most recent bounded commentary is retained. Control characters are removed, whitespace is
normalized conservatively, and content is capped below the configured transport message limit.

## Tests

- visible token fragments coalesce into one throttled edit;
- hidden reasoning has no progress-event path;
- tool milestones expose a tool name but no raw arguments/results;
- duplicate/no-op updates do not call the provider;
- locked authentication suppresses edits;
- a local/sidebar turn in a bound conversation is not mirrored;
- completion cancels pending timers and cannot be overwritten by a late progress edit;
- controller stop disposes listeners and timers;
- existing final outbox and compaction progress behavior remain green.

## Gates

1. Focused unit tests.
2. `npm run ci`.
3. `npm run package`.

## Acceptance

A Telegram remote request shows useful live commentary in one edited progress message during a long
agent run, remains within provider rate limits, leaks no hidden reasoning or raw tool data, respects
TOTP locking, and still delivers exactly one durable final outcome.

## Implementation record

- Added conversation-addressed visible progress events for native-model and CLI turns.
- Added a controller-owned coalescer that edits one progress message every 1.5 seconds, caps content,
  redacts CLI commands/tool arguments, suppresses unbound local turns, and rechecks TOTP before send.
- Preserved the durable final-answer outbox and existing compaction notifications.
- Focused progress/remote tests passed.
- `npm run ci` passed with 1,444 tests passed and 14 skipped after one unrelated lease-heartbeat
  test flaked once and passed both its isolated rerun and the complete rerun.
- `npm run package` passed and produced `forge-llm-0.14.0.vsix` (8.19 MB).
- A real Telegram request should be used for the final visual/rate-limit smoke check.
