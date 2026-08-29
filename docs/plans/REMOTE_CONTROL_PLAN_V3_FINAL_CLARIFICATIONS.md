# Forge Remote Control V3 — Final Sequencing Clarifications

Status: authoritative amendment to `REMOTE_CONTROL_PLAN_V3.md`; ready for final yes/no Codex review
Branch: `feat/remote-control-plan`

This amendment resolves the two sequencing questions recorded in `REMOTE_CONTROL_PLAN_V3.md` section 21.1. Where this amendment is more specific than V3, this amendment wins. No other V3 decision changes.

## 1. Authoritative rule: epoch advances only after durable acceptance

**Yes. The conversation user-intent epoch advances only after the new request has been durably accepted as either `queued` or `running`. A failed admission or failed persistence attempt does not advance the epoch.**

The ordering is authoritative for all remote paths:

### 1.1 Busy / queued path

```text
validate/auth/dedup/binding
        ↓
shared admission reports BUSY
        ↓
persist request durably as QUEUED
        ↓ persistence succeeds
advance conversation user-intent epoch
        ↓
associate queued request with that new epoch
        ↓
return durable-queued disposition
        ↓
provider cursor may advance / queued acknowledgement may be sent
```

If queued persistence fails:

```text
no durable request
no epoch advance
no suppression of the current chain's eligible auto-resume
provider event remains replayable
```

The epoch advance and durable queued record must be serialized by one conversation-scoped orchestration path. Implementations may persist the assigned epoch in the same record/update, but they must not publish the epoch to the live conversation before durable queued acceptance has succeeded.

### 1.2 Reserved / running path

```text
validate/auth/dedup/binding
        ↓
shared admission atomically returns RESERVATION
        ↓
while reservation is held:
  persist request durably as RUNNING
        ↓ persistence succeeds
advance conversation user-intent epoch
        ↓
bind reservation + request chain to that epoch
        ↓
return durable-accepted disposition / accepted acknowledgement
        ↓
enter canonical SendPipeline using the existing reservation
```

If `running` persistence fails while the reservation is held:

```text
release reservation
no model/tool execution starts
no epoch advance
no suppression of prior auto-resume
provider event remains replayable
```

Therefore V3 section 10's diagram must be read as conceptually placing `advance user-intent epoch` **after durable queued/running acceptance**, not before the shared admission/persistence decision.

### 1.3 Local sidebar path

Local user intents do not require remote request persistence, but must use the same admission/epoch semantics:

```text
shared user-send admission succeeds
        ↓
local intent is accepted by Forge
        ↓
advance user-intent epoch
        ↓
bind reservation/chain to epoch
        ↓
run canonical send path
```

A local send rejected before admission does not advance the epoch.

The important invariant is not "remote persistence everywhere"; it is:

> **Only an accepted real user intent may supersede an older automatic continuation. Failed attempts never mutate the user-intent epoch.**

## 2. Authoritative rule: compaction/resume reuses the existing reservation and epoch

**Yes. Auto-compaction and `resumeAfterCompaction` are internal continuation stages of the already-admitted request chain. They reuse the same conversation reservation and the same user-intent epoch. They do not reacquire the user-send admission gate.**

### 2.1 Request-chain context

Phase 1 must introduce/carry an internal request-chain context conceptually equivalent to:

```ts
interface RequestChainContext {
  conversationId: string;
  userIntentEpoch: number;
  reservation: TurnReservation;
  remoteRequestId?: string;
}
```

Exact type/name/location is implementation-defined, but these values must survive through:

```text
accepted user intent
  -> SendPipeline
  -> AgentLoop turn
  -> addressed post-turn context evaluation
  -> optional compaction
  -> optional resumeAfterCompaction
  -> final chain settlement
```

For remote-originated chains, `remoteRequestId` remains host-side correlation metadata. Native prompt text must not be modified merely to carry it.

### 2.2 Internal continuation is not a new user send

Current compaction code may call back into code that today resembles the normal send path. During Phase 1 that re-entry must be made explicit as an **internal continuation entry point**.

Conceptually:

```ts
sendUserIntent(..., reservation, epoch)

resumeInternalChain(chainContext, continuationPrompt)
```

or an equivalent internal flag/context on one canonical pipeline.

Required invariant:

```text
resumeAfterCompaction(chain epoch N)
        ↓
verify conversation's current accepted user-intent epoch is still N
        ├─ no  -> suppress automatic resume; old chain can settle
        └─ yes -> continue internally with SAME reservation + SAME epoch
                  and DO NOT call user-send reserve() again
```

This prevents the chain from deadlocking/rejecting itself against its own reservation.

### 2.3 Reservation lifetime

The reservation belongs to the full logical request chain, not only the first model turn.

It remains held across:

- the initial turn;
- addressed context-budget evaluation;
- compaction when triggered for that chain;
- eligible automatic resume/continuation;
- cancellation/failure cleanup.

It is released only when the request chain reaches its canonical settled state.

A newer accepted user intent can advance the epoch while the older chain still owns its reservation because that newer intent is queued rather than concurrently executed. The older chain then:

- may finish any already-running safe compaction;
- sees the epoch mismatch before automatic resume;
- suppresses that resume;
- settles and releases its reservation;
- allows the queued newer intent to acquire/adopt the next execution reservation and drain FIFO.

### 2.4 Where the context must be carried

The reservation/epoch must be passed through the existing orchestration seam that owns send -> post-turn budget evaluation -> compaction -> resume. It must not be reconstructed from the active tab, global state, transcript text, or remote routing state.

In practical Phase 1 terms, inspect and amend the current code path around:

- `SendPipeline`;
- `AgentLoop.runTurn()` / turn lifecycle;
- `ContextBudgetPublisher` / threshold evaluation;
- compaction launch;
- `resumeAfterCompaction` or equivalent callback into sending.

The request-chain context is conversation-scoped and internal to Forge core. Remote control only attaches optional correlation metadata when it originates the accepted intent.

## 3. Corrected canonical ordering

This replaces any conflicting shorthand ordering in V3 sections 4, 5, 10 and 11.

### Busy remote request

```text
inbound event
  -> auth/private-chat/dedup/binding
  -> shared admission says BUSY
  -> persist QUEUED
  -> persistence succeeds
  -> advance accepted user-intent epoch
  -> assign queued request to new epoch
  -> durable queued disposition
  -> provider cursor may advance
  -> older chain suppresses auto-resume if it observes epoch mismatch
  -> older chain settles/releases reservation
  -> queued request runs FIFO under its admitted chain context
```

### Idle remote request

```text
inbound event
  -> auth/private-chat/dedup/binding
  -> acquire shared conversation reservation
  -> persist RUNNING while reservation held
  -> persistence succeeds
  -> advance accepted user-intent epoch
  -> bind reservation + epoch + remoteRequestId into RequestChainContext
  -> durable accepted disposition
  -> provider cursor may advance
  -> canonical SendPipeline/AgentLoop
  -> addressed context evaluation
  -> optional compaction
  -> optional internal resume using SAME reservation/epoch
  -> terminal execution state + durable notification outbox
  -> chain settles
  -> release reservation
```

### Failed persistence

```text
admission/persistence fails
  -> release any provisional reservation
  -> no epoch advance
  -> no execution
  -> no provider durable-handled disposition
  -> event remains replayable
```

## 4. Tests required by these clarifications

Add explicit regression tests:

1. remote busy request whose queued persistence fails does not advance epoch and does not suppress existing chain auto-resume;
2. remote reserved request whose running persistence fails releases reservation and does not advance epoch;
3. successful durable queued request advances epoch exactly once;
4. successful durable running request advances epoch exactly once;
5. rejected local send does not advance epoch;
6. auto-compaction internal continuation reuses the original reservation and epoch;
7. `resumeAfterCompaction` never calls normal user-send admission for its own chain;
8. newer accepted queued intent suppresses older epoch auto-resume without starting concurrently;
9. old chain releases its reservation after suppressed resume, then queued FIFO drain proceeds;
10. remote request correlation survives compaction/resume without entering model-facing prompt text.

## 5. Implementation gate

With this amendment the answers to both Codex section 21.1 questions are explicitly **YES**:

1. epoch mutation happens only after durable remote acceptance (`queued` or `running`), never after a failed attempt;
2. compaction/automatic continuation reuses the already-admitted chain's reservation and epoch and bypasses fresh user-send admission.

No product/security decision from V3 is changed.

## 6. Final Codex yes/no prompt

> Review `docs/plans/REMOTE_CONTROL_PLAN_V3.md` together with its authoritative amendment `docs/plans/REMOTE_CONTROL_PLAN_V3_FINAL_CLARIFICATIONS.md` on branch `feat/remote-control-plan`. Verify only the two sequencing questions you raised in V3 section 21.1 and whether this amendment introduces any new implementation blocker. The authoritative rules are: (1) the user-intent epoch advances only after successful durable `queued`/`running` acceptance; failed persistence/admission leaves the epoch unchanged, and (2) compaction/`resumeAfterCompaction` is an internal continuation of the same request chain and reuses the same reservation and epoch without reacquiring normal user-send admission. If those resolve your two remaining questions and no new blocker exists, reply exactly: `READY FOR IMPLEMENTATION`. Do not implement code.
