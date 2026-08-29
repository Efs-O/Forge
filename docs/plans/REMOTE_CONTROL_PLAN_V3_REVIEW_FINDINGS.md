# Remote Control V3 — Code-Grounded Review Findings

Status: review of `REMOTE_CONTROL_PLAN_V3.md` + `REMOTE_CONTROL_PLAN_V3_FINAL_CLARIFICATIONS.md`
Resolution: incorporated into authoritative `REMOTE_CONTROL_PLAN_V4.md` during Phase 0
Branch: `feat/remote-control-plan`
Reviewed against: current `main` source, not the plan's own description of it
Date: 2026-08-29

Scope of this review: whether the plan's claims about **existing Forge code** hold, and
whether its stated invariants are self-consistent. The durability architecture
(notification outbox separate from execution state, provider cursor after durable
disposition, fencing-token lease) was checked and no defect was found there.

Verdict: findings 1, 2 and 3 are implementation-blocking. The seven corrections are the
right seven; every defect below sits at a point where the plan asserts something about
code that already exists.

---

## 1. BLOCKER — Correction 1 misdiagnoses the bug it exists to fix

V3 §3 states the problem as: a background remote turn "can accidentally evaluate or
compact the visible local tab instead of its own conversation."

The code disagrees. `src/sidebar/ContextBudgetPublisher.ts:106`:

```ts
if (conv.id !== this.deps.getSidebar().activeConversationId) return;
```

`evaluateThresholds()` is called at the **bottom** of `publish()`, behind that early
return. Consequences on today's `main`:

- a non-active conversation's thresholds are **never evaluated at all** — it can never
  auto-compact, and a background/remote conversation will run to context exhaustion;
- separately, because `SidebarProvider.postTokenBudget()` (`SidebarProvider.ts:308`)
  passes `this.getActive()`, a finishing background turn triggers a **spurious threshold
  evaluation of the active tab**, using the active tab's own token counts.

The plan names only the second, milder half.

Why this blocks: an implementer told "prevent wrong-tab compaction" can satisfy that
brief by tightening the active-tab guard, and ship a remote feature in which remote
conversations silently never compact. The prescribed split (conversation-scoped
evaluation vs. active-tab UI publication) is the correct fix, but the plan must state
explicitly that **the `activeConversationId` guard must continue to gate UI publication
and must NOT gate threshold evaluation.**

Required plan change: rewrite the §3 "Problem fixed" paragraph to name both halves, and
name `ContextBudgetPublisher.ts:106` as the specific guard whose scope changes.

### 1b. Same-name duplicate owner

`ContextBudgetPublisher` **already exists** as a class in `src/sidebar/`, and its
`publish(conv, evaluateThresholds)` is already conversation-parameterized. V3 §3
introduces an interface of the same name as though it were new. Under CLAUDE.md's Single
Point of Truth rule this must be phrased as extending the existing owner, not introducing
a new one. The practical fix at the call site is close to one line
(`SidebarProvider.ts:308`); the real work is the evaluation/publication split inside the
existing class.

---

## 2. BLOCKER — the local epoch rule contradicts its own invariant

Amendment §1.3 gives the local ordering as:

```text
shared user-send admission succeeds -> advance user-intent epoch -> run canonical send path
```

But `SendPipeline.send()` has four rejection gates that run **after** the busy/admission
check (`src/sidebar/SendPipeline.ts:68-110`):

- conversation not found;
- `validateAttachments()` failure;
- no active model selected;
- `resolveRequestModel()` throw.

Under §1.3 as written, a send that dies on "no active model selected" has already
advanced the epoch, and has therefore permanently suppressed the currently-running
chain's otherwise-eligible auto-resume. That directly violates the amendment's own stated
invariant:

> Only an accepted real user intent may supersede an older automatic continuation. Failed
> attempts never mutate the user-intent epoch.

Required plan change: local epoch advance must be specified as occurring **after all of
`send()`'s validation gates pass**, not at the admission gate. Either move the validation
above the admission gate, or move the epoch advance below it — the plan must pick one and
say which. Add a regression test: a send rejected for a missing active model does not
advance the epoch and does not suppress an in-flight chain's auto-resume.

---

## 3. BLOCKER — no object owns the reservation after `send()` returns

Amendment §2.3 asserts the reservation is held across the full logical chain: initial
turn, addressed budget evaluation, compaction, eligible resume, settlement.

The current code has no holder that outlives `send()`:

- `postTokenBudget` is typed `(evaluateThresholds?: boolean) => void` — fire-and-forget,
  called from `send()`'s `finally` (`SendPipeline.ts:126`);
- compaction and resume therefore run **detached** from the send call frame;
- resume re-enters the user path via `deps.send(text, convId, options)`
  (`compactionPolicy.ts:44`), which is `SendPipeline.send()` itself.

So `send()` returns — and under the plan would release its reservation — while compaction
is still being started asynchronously. Threading a `RequestChainContext` through argument
lists does not fix this; Phase 1 must convert the post-turn evaluation -> compaction ->
resume path into awaited, tracked chain state with an owner whose lifetime is the chain.

This is the largest single item in Phase 1 and the plan does not size it. §19's Phase 1
list should name it as its own work item, not fold it into "request-chain settlement
through compaction/auto-resume."

### 3b. No reservation escape hatch

The plan defines acquisition and release but no recovery. A leaked reservation
permanently bricks a conversation, and there is no local UI affordance to clear it. A
lease leak on re-borrow was already found during the 0.13.0 shared-runtime hardening
cycle — this is the same failure family, now on a path a user cannot see.

Required plan change: specify a force-release path (bounded staleness timeout, or an
explicit local command), and require that a stuck reservation is distinguishable in
`/status`.

---

## 4. Auto-continue cap is global and is not in the audit list

`SidebarProvider.ts:63` — `private autoContinues = 0`. One counter for the whole
provider, read at `:318`, incremented at `:320`, reset at `:373` and `:380`.
`CompactionService.ts:260` compares it against `MAX_CONSECUTIVE_AUTO_CONTINUES`.

The plan makes admission, epochs and context evaluation conversation-scoped but never
names this counter. With remote background turns, one conversation's auto-continues
exhaust the resume budget for every other conversation, including the tab in front of the
user.

Two more instances of the same class, both in `ContextBudgetPublisher`:

- `warningShown` — one boolean for all conversations, reset by `deps.resetContextWarning()`
  on every send from any conversation;
- `pendingTickConvId` / `tickTimer` — a single-slot throttle, so a background turn's tick
  displaces a pending tick for the active tab.

V3 §3's generic sentence ("Any context-warning/reset/threshold bookkeeping currently
global or active-tab-derived must be audited") should be replaced by this named list, so
the audit has a checkable definition of done.

---

## 5. Phase 2's exit criterion is unreachable at Phase 2

Phase 2's exit claims the fake channel can "safely accept/queue/**complete**/recover
tasks." But approval presentation is not decoupled from the webview until Phase 3 (§19).
Any Forge-native turn that hits a tool approval with no webview available will hang, so
"complete" is not demonstrable at Phase 2 for any turn that triggers an approval.

Required plan change: either move the approval multi-sink (Phase 3) into Phase 2, or
narrow Phase 2's exit criterion to auto-approved turns and state the restriction.

---

## 6. Smaller items

**6.1 Lease must be on a local filesystem.** `open(path, 'wx')` is atomic on a local
filesystem; exclusive create over SMB/CIFS is not reliable. This workspace lives on a
mapped network drive (`N:\`). V3 §9 should require the lease file live on local storage
(e.g. `~/.forge`) and forbid placing it in the workspace.

**6.2 Silent lease loss.** The lock key is per transport/account, which is correct — so a
second Forge window/workspace configured with the same bot token loses the race and stops
consuming. §9 says "refuse second consumer" but never requires informing the user. A
silently unreachable remote is the worst failure mode this feature has; require a
user-visible notice on refusal and on runtime fencing loss.

**6.3 "Remote origin never adds privileges" is a statement about the API, not the threat
model.** §13 keeps CLI providers remotely reachable with their existing local semantics.
Per CLAUDE.md's delegation section, Claude `read` access runs as `bypassPermissions`. The
practical delta is therefore not a new API surface but the **absence of a human at the
keyboard** when that CLI runs. This should be stated plainly in the security section
rather than left as an inference from §1 and §13.

---

## 7. What was checked and found sound

- notification outbox as a durable state machine separate from execution state, and the
  terminal ordering (execution terminal -> pending notification -> send -> receipt);
- provider cursor advancement strictly after durable disposition, with replay safety
  resting on durable dedup;
- restart rule: `running` becomes `unknown`, never auto-replay;
- pairing as the sole pre-auth route, with the ordered check list and
  persist-before-confirm;
- fencing-token lease semantics, including release-only-on-token-match and fail-closed on
  PID ambiguity;
- the synchronous (non-Promise) shape of `TurnAdmission.reserve()` — correct, since the
  existing `isStreamingConv` -> `await waitForCancelledTurns()` -> re-check sequence in
  `SendPipeline.send()` is exactly the TOCTOU the gate has to close.

---

## 8. Requested Codex action

Confirm or refute findings 1, 2 and 3 against `main`, since each rests on a specific line
of existing code:

- `src/sidebar/ContextBudgetPublisher.ts:106` and `src/sidebar/SidebarProvider.ts:308`;
- `src/sidebar/SendPipeline.ts:68-110` and `:126`;
- `src/sidebar/compactionPolicy.ts:44`, `src/sidebar/SidebarProvider.ts:63`.

If they hold, V3 §3, amendment §1.3 and amendment §2.3 need amendment before
`READY FOR IMPLEMENTATION`.
