# Claude stand-in: resume the joined conversation, and tell the user

Status: Phase 1 implemented 2026-09-23 (`src/agentMesh/claudeStandIn.ts`); Phase 2
(live) pending. Owner: Claude (Opus) writes it, Codex reviews it.

Implementation notes against §3: the stand-in key carries a per-instance
counter (`claude-stand-in:<id>:<n>`), because the orchestrator reuses an idle
FIFO whose adapter key matches, and a disposed stand-in must never be reused.
The peer lookup excludes the stand-in's own pid, since a resumed process
carries the joined session id. The board notice uses the existing terminal
`recovered` state rather than adding a protocol state.

## 1. Why

At 08:53 on 2026-09-23 Codex sent `forge.sh send codex claude`. The joined
Claude session (`forge.sh join claude`, session `5e6adee1`) was not running:
a window reload for the 0.16.37 install had stopped it, and it stays stopped
until its panel is opened. `claudeAdapterAsync`
(`src/agentMesh/sessionProvider.ts`) did what it was designed to do. It
started a Forge-owned stand-in (`a953c424`) and attached
`CLAUDE_STAND_IN_NOTE`, and the exchange log recorded `completed`.

That design fails the user in three ways:

1. **The stand-in has none of the conversation.** It starts a blank session,
   even though the alias record already holds the joined session's id
   (`claude_session_id`). `claude --resume <id>` would load that history.
2. **Nobody sees the note.** Only `liveSessionTool` and `tellLiveSessionTool`
   read `adapter.note`. The relay path (`meshOrchestrator.relay`, via
   `fifoFor`) drops it. The user found out only by reopening the panel by
   hand.
3. **The stand-in cannot run a shell.** `defaultClaudeFactory` passes no
   `permissionMode`, so `claude -p` runs in the default mode and refuses Bash.
   The stand-in said "shell commands are blocked in this session". CLAUDE.md
   § "CLI Agent Delegation" requires `bypassPermissions` for Forge-launched
   Claude.

A dead Claude Code process cannot be woken. Nothing on the machine can reach
it until its panel opens. This plan does not try to wake it. It makes the
stand-in continue the same conversation, and it makes the substitution
visible.

## 2. Non-goals

- Reopening the VS Code Claude panel programmatically.
- Changing the live-peer path. A running joined session still gets the
  message through its peer pipe, as it does today.
- Changing Codex ownership or resume.

## 3. Design

**3.1 Resume the joined session (fixes 1).** Revised after Codex's review
(2026-09-23). A stand-in is **not an owned session**. It lives in a new module,
`src/agentMesh/claudeStandIn.ts`, and never touches owned-session state:

- no `claudeOwned` map entry;
- no `writeOwnership`, no `registerAlias`, no `recordConfirmedId`.

So M3 resume, `recoverOwnership` and the TTL reaper cannot see it, and the
user's session id cannot leak into `ownership/claude.json`. Codex showed that
the owned path persists `confirmedSessionId` in three places
(`sessionProvider.ts:368-387`, `:100-103`, and `ownership.ts:413-428`), so
reusing that path is exactly what must not happen.

When `claudeAdapterAsync` finds the alias joined (`peer_pid` set) but the peer
dead, it asks `claudeStandIn` for an adapter:

- If the alias record has `claude_session_id`, spawn `ClaudeOwnedSession`
  with `confirmedSessionId` set to that id, which becomes `--resume <id>`.
  Its adapter key is `claude-stand-in:<id>`.
- Without an id (an older join), spawn a blank session, as today.
- If Claude reports a different `session_id` (a fork), the note says so, and
  the answer lives in that session rather than in the joined one.

**Lifetime: one-shot at the FIFO boundary.** `MeshAdapter` gains an optional
`onIdle()`. `AliasFifo` calls it when its queue drains after a send
(`aliasFifo.ts:226-243`, which is where the send result is recorded). The
stand-in's `onIdle` disposes the process. The stand-in is also disposed:

- when `claudeAdapterAsync` next finds the joined peer live;
- when the provider is disposed (window deactivation).

Messages queued while the stand-in is busy still go through the same stand-in
before it is disposed. The next idle message resolves afresh: a new stand-in
if the peer is still dead, or the live peer.

**Residual risk (accepted):** the user can open the panel while the stand-in
is answering. The panel then shows the transcript as it was when opened. The
stand-in's append lands later and is visible after the panel reloads. The
window lasts one FIFO drain.

**The note says what happened:** the joined session was not running; Forge
resumed it headless to answer; the answer is in its history; open the panel to
continue.

**3.2 Surface the substitution (fixes 2).** `MeshSessionProviderDeps` gains
`onStandIn(alias, note)`, alongside `onContextLost`. `claudeAdapterAsync`
calls it when it returns a stand-in. `agentMeshSetup.ts` wires it to:

- `vscode.window.showWarningMessage(note)`;
- a Telegram host notification (`RemoteController.enqueueHostNotification`)
  for the exchange's conversation, when remote control is on;
- a `notice` board event, which keeps the exchange log accurate.

**3.3 Permission mode (fixes 3).** `defaultClaudeFactory` passes
`permissionMode: 'bypassPermissions'`, per CLAUDE.md § "CLI Agent Delegation";
nothing in the repo explains why it was omitted. The stand-in's
`ClaudeOwnedSession` gets the same mode. The stand-in therefore has
unrestricted CLI access in the workspace, the same as delegated Claude.
Rollback is the workspace checkpoint.

**3.4 File size.** `sessionProvider.ts` is at 500 lines (`wc -l`). The
stand-in code lives in `claudeStandIn.ts`. `sessionProvider.ts` changes only:

- the three-line stand-in branch becomes a call into `claudeStandIn`;
- dispose-on-live-peer is added.

If that does not net to zero lines, move `claudeAdapter` and the joined-peer
branch into `claudeStandIn.ts` as well. That is the natural seam, since both
concern the joined peer and not owned sessions. Add a `docs/OWNERS.md` row.

## 4. Phases

**Phase 1 (one commit).**

- 3.4 extraction, with no behaviour change. The existing mesh tests must stay
  green unchanged.
- Then 3.1, 3.2 and 3.3.
- Unit tests:
  - a stand-in resumes `claude_session_id` and writes no ownership or alias
    record (the ledger's CI row);
  - a stand-in is disposed when the joined peer is live again;
  - `onStandIn` fires once per stand-in creation;
  - the factory passes `bypassPermissions`.

**Phase 2 (live).**

1. Close the Claude panel.
2. `forge.sh send codex claude` a question that needs the conversation's
   context.
3. Confirm the warning appears in VS Code and on Telegram.
4. Reopen the panel and confirm the answer is in its history.

## 5. Acceptance criteria

- A relayed message to a dead joined session produces a VS Code warning and a
  Telegram notice, within the same exchange.
- The stand-in's answer appears in the joined session's own history.
- `ownership/claude.json` never holds the joined session's id in `session_id`.
- No stand-in process outlives its exchange, or the joined peer's return.
- `npm run ci` is green. No source file exceeds 500 lines.

## 6. State × lifecycle ledger

Forge writes no new durable state. The stand-in is in memory only. It adds no
field to `OwnershipRecord` and writes no ownership or alias record. The one
durable artifact involved is the joined session's transcript, which Claude
Code owns.

| Artifact | create | delete | pause/disable | crash mid-write | owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| stand-in process (in memory, `claudeStandIn`) | `claudeAdapterAsync` on a dead joined peer | `onIdle` after the FIFO drains; joined peer live again; provider dispose | never parked; a stand-in has no park state | a stand-in that exits mid-answer fails the send; the FIFO records `failed` and 3.2 has already notified | the extension host dies, and the child's stdin pipe closes with it; `claude -p` stream-json exits on EOF | none needed: one-shot. It is invisible to the owned-session TTL reaper by construction |
| joined session transcript (`~/.claude/projects/<slug>/<id>.jsonl`) | Claude Code appends the stand-in's turn through `--resume`; Forge never writes the file | never deleted by Forge; Claude Code owns retention | n/a: Forge never pauses the user's session | a killed stand-in leaves a partial turn, which Claude Code's own resume tolerates | panel opened mid-answer: two writers for one FIFO drain (accepted in 3.1); the panel shows the append after it reloads | n/a: Claude Code's retention |
| `ownership/claude.json` (existing, untouched) | not written by the stand-in path | not touched | not touched | not touched | not touched | not touched |

CI-enforced row: a unit test that makes the stand-in path run with a fake
factory, then asserts:

- `ownership/claude.json` does not exist, or is byte-identical to before;
- the alias record is unchanged;
- the factory received `sessionId === claude_session_id`.

A later change that routes the stand-in through owned-session persistence
fails this test.
