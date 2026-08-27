# Delegate Safety & Local Tool Access — Findings and Proposals

Status: **report for review — nothing implemented.**
Date: 2026-08-16. Grounded in a read of the current `main` working tree.

## Decisions already taken by the user

- **Codex** — approved to proceed with the approval-channel work.
- **Claude** — no changes yet. Findings are recorded below but **not actioned**,
  including the `Bash` allow-list issue (F2), which stays open on purpose.
- **Autonomy model** — long-running agents must be able to work without a user
  monitoring or repeatedly approving individual actions. The intended middle
  ground is autonomous work inside a bounded workspace, with automatic denial
  of narrowly-defined destructive or out-of-scope actions.
- **Rename** `replace_in_file` → `edit_file` — requested; scope costed in §6.

---

## 1. The core structural finding

`CliAgentDriver` is a **one-way pipe**. It spawns the CLI, reads stdout, parses,
and exits ([src/agents/CliAgentDriver.ts:36-42](src/agents/CliAgentDriver.ts#L36-L42)):

> *"Forge injects no tools here — the CLI runs its own agentic loop with its own
> tools; this driver only relays stdout/exit status."*

Consequence: by the time `codexAdapter` emits `[codex: exec …]`
([src/agents/adapters/codexAdapter.ts:57](src/agents/adapters/codexAdapter.ts#L57)),
**the command has already run**. There is no point at which Forge can decline an
individual action.

The only control today is the **coarse access level chosen at spawn**:

| access | Codex | Claude |
|---|---|---|
| `read` | `--sandbox read-only` | `bypassPermissions` + read-only `--allowedTools` |
| `write` | `--sandbox workspace-write` | `--permission-mode acceptEdits` |
| `full` | `--sandbox danger-full-access` | `bypassPermissions`, unrestricted |

Sources: [codexAdapter.ts:22-27](src/agents/adapters/codexAdapter.ts#L22-L27),
[claudeAdapter.ts:36-49](src/agents/adapters/claudeAdapter.ts#L36-L49).

Entry point determines which is used:

| Entry point | access | Owner |
|---|---|---|
| `ask_local_agent` | always `read` (hardcoded) | [CliDelegationRunner.ts:78,94](src/delegation/CliDelegationRunner.ts#L78) |
| `dispatch_workers` | `read` or `write`, **model's choice** | [dispatchWorkersTool.ts:106](src/tools/dispatchWorkersTool.ts#L106) |
| direct sidebar chat | `full` | [CliChatRunner.ts:113,150](src/agents/CliChatRunner.ts#L113) |

---

## 2. Findings

### F1 — The local model selects its own delegate privilege level
**Severity: high.** `dispatch_workers` exposes `access: read | write` as a model-chosen
argument. Nothing external constrains the choice; the user is not consulted on the
level itself. Observed live in the user's screenshots: the model reasoned
*"I'll grant write access to the weather-app path"* and did so.

The lock exists; the local model holds the key.

### F2 — Claude's "read-only" mode includes `Bash`
**Severity: high. NOT being changed this round, per user decision.**

[claudeAdapter.ts:8](src/agents/adapters/claudeAdapter.ts#L8):

```ts
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch'];
```

The adjacent comment states the list *"deliberately excludes every mutating tool
(Write, Edit, NotebookEdit) so read-only is enforced by the allow-list."*
`Bash` deletes files as effectively as `Write` does, and the mode is
`bypassPermissions`. So `ask_local_agent` → Claude is documented as read-only and
can execute destructive shell commands.

Codex does not have this problem: `--sandbox read-only` is enforced by the OS
sandbox, not by a tool list.

### F3 — Forge's denylist never applies to delegates
**Severity: high.** [DenyList.ts](src/tools/DenyList.ts) covers `rm -rf`,
`git reset --hard`, `git clean -f`, force-push, SQL `DROP`, `Remove-Item -Recurse
-Force`, `diskpart`, and more. It is checked only inside Forge's own terminal
tools ([execTools.ts:50-55](src/tools/execTools.ts#L50-L55)).

Claude and Codex run **their own** shell tools. Forge never sees those command
strings, so the denylist cannot fire on them.

### F4 — `full` access is reachable and unsandboxed
**Severity: medium-high.** Direct sidebar chat with a `provider: cli` model runs
`access: 'full'` → `danger-full-access` / unrestricted `bypassPermissions`. No
sandbox, no denylist, and **no checkpoint** (checkpoints are `write`-only —
[CliWorkerRunner.ts:76](src/agents/CliWorkerRunner.ts#L76)).

### F5 — Writable-path confinement is advisory for CLI workers
**Severity: medium.** `WorkerAccessPolicy` enforces per-path writes for native
workers. For CLI workers the path list is only injected into the prompt text
("You may modify ONLY these paths…" —
[CliWorkerRunner.ts:39-46](src/agents/CliWorkerRunner.ts#L39-L46)).
Actual enforcement is the CLI sandbox, and Codex `workspace-write` permits the
**entire workspace**, not the assigned subset. Checkpoint is the recovery path.

### F6 — Local models currently have no shell at all
**Severity: informational — this is the cause of the observed behaviour.**

`.forge/config.yaml` declares only:

```yaml
permissions:
  agents:
    delegate: true
    cloud_workers: true
```

Everything else falls to schema defaults
([schema.ts:163-192](src/config/schema.ts#L163-L192)), where
`exec.terminal` and `exec.headless` are both `false`. `run_terminal` and
`exec_command` are therefore never advertised to local models.

**The asymmetry that matters:** local models are fully locked out of the shell,
while `delegate: true` lets them hand any shell job to Codex or Claude, who have
unguarded shells. The strict gate has an unguarded side door.

### F7 — Clanker mode silently auto-approves `exec_command`
**Severity: medium (latent — only bites once `headless` is enabled).**

[ToolApprovalService.ts:45](src/sidebar/ToolApprovalService.ts#L45):

```ts
if (this.clankerMode && !dangerous) return Promise.resolve(true);
```

`terminal` and `headless` always require confirmation in normal operation
([ToolDispatch.ts:166-173](src/sidebar/ToolDispatch.ts#L166-L173)) — that part is
already correct. But `exec_command` declares no `approval?.()` metadata, so
`dangerous` is `false`, so clanker mode approves it with no popup.

---

## 3. Target policy — autonomous, bounded, and explicit

The approval channel should be an **automatic policy decision point**, not a
stream of modal prompts. Ordinary coding actions are allowed without waiting
for the user; actions outside the session's granted capability are denied
automatically and visibly in the transcript.

| Session capability | Intended work | Policy |
|---|---|---|
| Autonomous workspace | normal implementation, tests, builds, workspace-scoped edits | Allow routine work; sandbox to the workspace; checkpoint before writable work; deny dangerous commands automatically. |
| Autonomous + network | dependency, documentation, or approved API work | Same as above, with only the configured network capabilities enabled. |
| Publish/admin | releases, deployment, remote mutations, or machine administration | Require explicit, one-time session-level user consent; do not use as the default chat or worker profile. |

The automatic deny policy should cover only high-confidence red lines, including
broad or recursive deletion, destructive Git operations, disk/system
administration, credential-store access, privilege changes, force-pushes,
database destruction, and writes outside the assigned workspace. It must not
replace the sandbox: a denylist is a backstop, whereas the workspace sandbox is
the primary boundary.

Forge should show the active capability on each delegate turn (for example,
`Autonomous workspace — external publishing blocked`) and persist the granted
capability, checkpoint ID, and every automatic allow/deny outcome in the
conversation record. This gives the user one clear consent decision at the
start of a long run rather than approval fatigue throughout it.

## 4. Proposal A — Codex approval channel *(approved to proceed)*

The transport already exists. [CodexAppServerSession.ts](src/agents/CodexAppServerSession.ts)
speaks the Codex app-server JSON-RPC protocol, and line 142 currently sets:

```ts
approvalPolicy: 'never'
```

Proposed change, in order:

1. Switch `approvalPolicy` to `untrusted` for command execution and patch
   apply. Forge then receives the non-read approval requests and can make the
   automatic bounded-autonomy decision; `on-request` would leave escalation
   requests to the model's discretion.
2. Handle the inbound approval RPC in the session's `handleNotification` /
   request path.
3. Evaluate one shared action policy: reuse [DenyList.ts](src/tools/DenyList.ts)
   for the destructive-command definitions, then apply the active session
   capability and workspace boundary. Forge-native tools and Codex delegates
   must share the same red-line definitions rather than grow separate lists.
4. On a denylist hit → reply deny, and surface the refusal in the transcript
   (per CLAUDE.md: never bury it in logs).
5. On no hit → automatically allow actions that fit the active session
   capability. Do not issue a modal approval for routine commands, patches, or
   workspace edits.
6. On an action outside the active capability (for example publishing or
   machine administration from an autonomous-workspace session) → deny and
   surface the reason in the transcript. A later publish/admin capability may
   be explicitly granted for a new or elevated session.

Note this path currently serves warm direct chat. Whether worker/delegation runs
also move onto the app-server transport (rather than `codex exec --json`) is a
scoping decision; the one-shot `exec` path has no approval channel at all, so
the guard only covers whatever runs through the session.

**Also proposed alongside:** never pass `danger-full-access` for normal chat or
workers. Cap Codex at `workspace-write` and take a checkpoint unconditionally,
including for chat (closes F4 for Codex). `danger-full-access` must not become
the workaround for a missing workspace capability; publishing/admin needs its
own explicitly-consented design.

The approval-capable app-server path is the correct place to make these
automatic decisions. The one-shot `codex exec --json` worker path has no such
channel, so it must be treated as unguarded until it either moves onto an
approval-capable transport or is constrained to a policy that the OS sandbox
can enforce. The UI must not imply that a one-shot worker has per-command
guardrails when it does not.

## 5. Proposal B — local shell with autonomous guardrails

Enable Forge's own execution tools so routine work stops being delegated:

```yaml
permissions:
  fs: { read: true, write: true, delete: false }
  net: { search: false, fetch: false }
  exec: { terminal: true, headless: true }
  git: { read: true, write: false }
  agents:
    delegate: true
    cloud_workers: true
```

(The whole block must be spelled out — today only `agents:` exists, so the rest
are silent defaults.)

- **`run_terminal`** — low risk. Denylist-checked, then *pasted* into a VS Code
  terminal; the user presses Enter. It cannot self-execute
  ([execTools.ts:57-63](src/tools/execTools.ts#L57-L63)).
- **`exec_command`** — genuinely executes, but no shell, shell operators banned,
  PowerShell banned, `guardExec` applied. **Prerequisite: fix F7** by adding
  policy metadata so clanker mode cannot run an out-of-capability invocation
  silently.

Normal, in-capability local commands should be automatically allowed, with a
clear transcript record. The existing dedicated `run_tests` / `run_build` tools
remain preferable for common cases because their intent is narrower and easier
to validate than arbitrary command execution.

**This does not fix F2/F3.** It is orthogonal — but it reduces delegation
pressure, which indirectly reduces exposure to the unguarded path.

## 6. Proposal C — rename `replace_in_file` → `edit_file`

**Scope: 26 occurrences across 16 files.** No name collision (`edit_file` is
unused; `apply_line_edits` is distinct). Call sites needing coordinated update:

| Area | Files |
|---|---|
| Definition | `src/tools/fileEditTools.ts` (4) |
| Worker allow-list | `src/workers/WorkerAccessPolicy.ts` (3 — incl. the `filepath` vs `path` field special-case at lines 122, 156) |
| Dispatch | `src/sidebar/ToolDispatch.ts` (1) |
| Prompt templates | `src/templates/builtin/execute.njk`, `config/templates/builtin/execute.njk` |
| Harness | `scripts/tool-harness-runner.mjs` |
| Tests | `RegisterAllTools`, `WorkerAccessPolicy`, `MessageOps`, `GemmaCapabilities.live` |
| Docs | `docs/TOOL_COVERAGE.md`, `docs/OWNERS.md`, plan files |

Decision: use `edit_file`. It follows the existing `verb_noun` snake_case style
(`read_file`, `write_file`, `search_code`) and is more explicit for both users
and models.

Archived conversations store the old tool name in their tool turns. Replay is
display/history only, not re-dispatch, so this should be cosmetic — but it has
not been verified against a real reload.

## 7. Remaining design questions for review

1. **Codex approval scope** — the proposed default is automatic denial of red
   lines plus automatic allow of routine in-capability work. Confirm which
   actions, if any, should require a one-time session elevation rather than an
   automatic denial.
2. **One-shot worker coverage** — should approval-capable app-server transport
   be required before Codex workers can receive write access, or is
   workspace-write sandboxing plus checkpoints sufficient as an interim policy?
3. **Worker privilege escalation** — `dispatch_workers` should no longer let a
   local model choose `write` unilaterally. The proposed rule is read by default
   and a one-time Forge-side user consent before a worker receives write access.
4. **Claude boundary** — before Claude can be described as autonomous
   read-only, it needs an execution-level control for `Bash` (hook, policy
   channel, or sandbox). Prompt text and a Forge-side denylist are insufficient.

## 8. Confidence notes

- §1-§2 findings are read directly from the current tree, with file:line cited.
- §3 is a proposed product/security policy for review, not a claim about
  capabilities already present in the current implementation.
- The Codex app-server protocol supports approval requests; **the exact RPC
  method names and payload shape have not been verified** against the installed
  Codex build (0.144.x). Step 1 of any implementation is confirming them.
- F2's real-world exploitability assumes Claude Code's `Bash` tool resolves a
  working shell on this Windows machine. Not tested — and not being changed this
  round regardless.
- The Claude-side remediation options (`PreToolUse` hook, `--permission-prompt-tool`)
  come from general knowledge of Claude Code, **not** from this repo, and are
  explicitly out of scope per the user's decision.
