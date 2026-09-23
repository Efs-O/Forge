# Prefix rewrites: stop rewriting history the model has already read

Follow-up to `PROMPT_PREFIX_STABILITY_PLAN.md` §7 ("Measure the
`supersedeStaleReads` tradeoff — nobody has priced it"). It is priced now, and
the price is too high. A second rewrite, the turn-context move at turn start,
has been open since 2026-09-23 and is fixed here as well.

## 1. The problem, measured

Both causes rewrite a message in the middle of the model-facing history. On
the hybrid/recurrent models Forge targets locally (Qwen3.8, Qwopus),
llama-server cannot shift KV across an edit (`--cache-reuse` is disabled for
them; see `SLOT_AFFINITY_AND_CHECKPOINTS_PLAN.md` §4). It can resume only from a
saved context checkpoint, and it keeps those near the end of the prompt. A
rewrite far from the tail therefore re-evaluates **the whole prompt from token
0**, not just the part after the edit.

### 1.1 `supersedeStaleReads` (the big one)

MID_TURN_TELL Phase 4, chat `c095313c`, Qwopus V2 Q5_K_M, 2026-09-23. One
49-minute turn at ~100K tokens.

- Four rounds re-evaluated the entire ~100K prompt, at 142–150 s each: about
  **10 of the 49 minutes**.
- Every one follows a `read_file` of a path first read about 40 minutes
  earlier (`RemotePromptAdmission.ts` at 10:31:48, `RemoteCore.test.ts` at
  10:36:45).
- The log line for the first shows `f_keep = 0.425`: the prompt diverged at the
  earlier read. Then the checkpoint restore fell back to token 0.

The mechanism: `supersedeStaleReads` (`src/agent/staleReadSupersede.ts`)
replaces the EARLIER copy of a re-read file with a one-line notice. That text
has been in the cache since the first read. Replacing it is a mid-history
rewrite.

What the elision buys is small by comparison. The elided copy was already
cached, so it cost no prefill; it cost only context room. The median read is
about 1,000 tokens (`TOKEN_EFFICIENCY_PLAN.md` §3), and 14.4% of reads re-read a
path. Under real context pressure, `prepareToolResultContext` excerpting is
already the lever that reclaims room, and it stays (§5).

### 1.2 Turn-context move at turn start

`injectTurnContext` (`src/sidebar/turnContext.ts`) folds the Layer C block
(active file, plan, terminal state, remote reach) into the latest non-midTurn
user message. When a new turn starts, the block leaves the previous request and
moves to the new one. Everything after the previous request (the whole previous
turn's tool rounds) is re-evaluated.

Measured on Qwopus, 2026-09-23, with a one-word "reply OK" turn after a
compacted conversation: 2,918 tokens re-evaluated in 5.8 s (`f_keep 0.932`) on a
26,320-token prompt. That was small only because compaction had shrunk the
previous turn. After an uncompacted agentic turn, the re-read is the whole
turn: tens of thousands of tokens. On a hybrid model it can fall back to token 0
for the same checkpoint reason as §1.1.

The mid-turn-tell variant of this (a tell became the fold target) was fixed in
`87927e3`.

## 2. Principle

**A message's model-facing bytes may depend only on that message and on what
came before it, never on what came after.** A prompt built that way is
append-only: round N+1's prompt starts with round N's prompt, byte for byte. Both
causes break this rule. Supersede makes message *i* depend on a later read. The
turn-context fold makes the request depend on whether a later user message
exists.

Compaction, excerpting under pressure, image age-out and scoped instructions
still break it on purpose. They are listed in §5 and are out of scope.

## 3. Fix A: mark the new read instead of rewriting the old one

Rename `supersedeStaleReads` to `annotateRereads` (same file, same pipeline
slot). It no longer elides anything. Instead it appends a note to the LATER
result, which is new at the tail and has never been cached:

```
[Forge: this replaces your earlier read of <path>. That earlier copy is stale; use this one.]
```

Rules, carried over from the current safety rule:

- Annotate result *i* only when a complete `read_file` result for the same path
  exists **before** *i*. The condition looks backwards only, which is what makes
  it append-only.
- "Complete" keeps its current meaning (`isCompleteRead`): errors, `[Forge:`
  notices and cap-truncated results neither trigger nor receive the note.
- Path normalisation (`\` to `/`) and pairing by `tool_call_id` are unchanged.
- The earlier result is never touched.

This also fixes the case the old design could not: the model now sees, *in
the result it is reading*, that an older copy exists and which one is current.

The note is appended before `stampToolResultClocks`, so the clock stamp stays
last, as it is today for the truncation nudge.

## 4. Fix B: freeze each request's block on that request

Add one optional persisted field to `ChatMessage`:

```ts
/** The Layer C block this user turn was sent with, rendered once at turn start. */
turnContext?: string;
```

- **Freeze.** A new export in `turnContext.ts`, `freezeTurnContext(messages,
  state)`, renders the block from the turn-start snapshot and writes it onto the
  turn-opening user message (the last non-midTurn user message). It is called
  once per turn from `ModelTurn`, right after the snapshot at
  `ModelTurn.ts:263`. **ModelTurn.ts is at exactly 500 lines**, so the call
  site must be a one-line replacement or net zero; all the logic lives in
  `turnContext.ts`.
- **Idempotent.** If the target already has `turnContext`, freezing leaves it
  alone. A retry that reuses the same user message is byte-identical to the
  first attempt.
- **Request identity.** The frozen block belongs to the message object it was
  written on. Any path that creates a new user message gets a new freeze. Any
  path that rewrites an existing user message's content must drop its
  `turnContext` in the same place. Codex found no edit-and-resend path in
  `src/sidebar` (2026-09-23); grep again at implementation time.
- **Inject.** `injectTurnContext(messages, current)` runs on the windowed
  view, as today. `current` is this turn's block: the frozen text for a model
  turn, the live-rendered block for a CLI turn. Two steps, in order:
  1. Every visible user message that carries `turnContext` gets that block
     folded into itself, in place. Nothing moves.
  2. If the last non-midTurn user message in the view has **no** frozen block,
     `current` folds into it exactly as today, or stands alone when there is no
     user message at all (the existing fallback).

  Step 2 fires in three cases only:
  - a CLI turn;
  - a conversation from before this change;
  - compaction has windowed the turn-opening message out, so the last user
    message in view is the compaction preamble.

  The third is a compaction, which is a full reset anyway. Until the next
  compaction the target stays the same, so the rounds after it are still
  append-only.
- **CliTurn** does not freeze. Its only state is the plan, and a CLI agent
  receives the transcript once per turn, not on a warm llama-server slot. It
  still sees earlier frozen blocks, which is correct.
- **Stale blocks are the accepted cost.** Old requests keep the plan and active
  file they were sent with, a few hundred tokens each, until compaction drops
  them. The block header changes from `[Forge turn context]` to
  `[Forge turn context, as of this message]` so the model reads an old block as
  history, not as now. Check every reader of `TURN_CONTEXT_OPEN` when changing
  it.
- **Not shown in the sidebar.** `DisplayPersistMessage` does not carry the
  field.
- **Logged.** `SessionLogger.flush` writes user rows from message content only
  today (`SessionLogger.ts:279-293`). Add a separate `turn_context` field to the
  user row when the message has one, and do not fold it into `content`: offline
  audits count and hash content. This keeps what the model was actually told
  diagnosable (CLAUDE.md, "the session log is the only forensic record").

Rejected: omitting a block that is identical to the previous turn's. It saves
tokens, but "as of this message" then points at the wrong message, and the
saving is small next to the tool results around it.

## 5. What still rewrites history, on purpose

Unchanged, and `PROMPT_PREFIX_STABILITY_PLAN.md` §3 is updated to say so:

- **Compaction**: a full reset is expected.
- **`prepareToolResultContext` excerpting**: only under context pressure, where
  room beats a warm cache.
- **Image age-out** (`ageOutImageParts`): once per image, after
  `image_retention_turns`.
- **Scoped project instructions**: activeFile-derived; nested-repo workspaces
  only.

`supersedeStaleReads` leaves that list. §7's "measure the tradeoff" item is
marked done with a pointer here.

## 6. Phases

**Phase 1 — Fix A.** `annotateRereads`, its unit tests (rewrite
`StaleReadSupersede.test.ts`), the prefix property test (§8), OWNERS row
rename. One commit.

**Phase 2 — Fix B.** The field on `ChatMessage`, `slimMsgSchema`,
`slimPersistMessages` and `chatMessagesFromSlim` (also remove the duplicated `stampedAt` spread at
`sessionTypes.ts:338-339`), `freezeTurnContext`, the injector change, the
header wording, the session-log field, tests. Update
`promptPrefixStability.test.ts`:
- "emits exactly one context block" becomes one block per frozen message plus
  at most one live block;
- case D (plan changed) now diverges nowhere: the new block is appended with
  the new request.
One commit.

**Phase 3 — docs and live check.** `PROMPT_PREFIX_STABILITY_PLAN.md` §3/§7,
CHANGES.md, the live measurement in §8. Then 0.16.38.

## 7. State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `ChatMessage.turnContext` on a persisted user message | `freezeTurnContext`, once per turn, before round 1; never overwritten | Goes with its message: clear chat, delete conversation. Compaction drops it from the model view only; `conv.messages` keeps it | No toggle. CLI turns do not freeze; a message without the field falls back to today's live fold | The field is set in memory before the conversation is next persisted (`sessionPersistence.ts` via `slimPersistMessages`; the archive uses `writeFileAtomicSync`). A crash before the write reloads the message without it. A retry of that request then freezes a new block from a new snapshot, so it is not byte-identical to the crashed attempt. That is accepted: the crash already cost the warm prompt, since the crashed round was never appended | Same as crash: the field is present exactly when the conversation write that followed the freeze landed | None. It lives as long as its message; compaction bounds how much of it the model sees |
| Frozen block in the session log user row | Written with the user row | Never; the log is append-only | Not applicable: it is logged whenever the field exists | An interrupted append can leave a partial last line. `SessionLogger`'s cursor scan parses only lines containing `cursor`; offline audits must skip unparsable lines | Same as crash | Session-log retention, unchanged |

Nothing else durable. `annotateRereads` is model-facing only and stores nothing.

**CI-enforced row:** a unit test that `slimPersistMessages` followed by a
restore round-trips `turnContext` byte-identically. That is the create cell; if
a later change drops the field from the schema, the frozen history silently
re-renders after every reload and the prefix breaks with no error.

## 8. Acceptance criteria

- [ ] **Prefix property (unit).** Run the model-facing chain from
      `applyCompactionWindow` through `stampToolResultClocks` (image aging
      included, `prepareToolResultContext` with room to spare) on
      messages[0..k] and messages[0..k+n], with the same compaction state for
      both. The first output must be a byte prefix of the second. Cover each
      extension:
      - a re-read of an early file;
      - a new user turn with a changed plan and active file;
      - an appended mid-turn tell;
      - a compaction state whose window starts after the turn-opening message
        (the preamble is the fold target, stable across rounds);
      - a window with no user message (the standalone fallback, stable across
        rounds).
      No image in the fixture may cross `image_retention_turns` between the two
      runs: age-out is a deliberate rewrite (§5).
- [ ] A change of compaction state, or an image crossing its retention
      threshold, is still allowed to diverge (case H stays).
- [ ] An earlier `read_file` result is byte-identical before and after a later
      re-read of the same path; the later one carries the note.
- [ ] A cap-truncated or error read neither receives nor triggers the note.
- [ ] Freezing is idempotent; regenerate reuses the frozen block.
- [ ] A conversation from before this change (no field anywhere) behaves exactly
      as today.
- [ ] The persistence round-trip test from §7.
- [ ] `npm run ci` green; ModelTurn.ts still at or under 500 lines.
- [ ] **Live, Qwopus, llama-server log.** Re-read a file first read at least 20
      rounds earlier: the next round shows `f_keep ≥ 0.99` and re-evaluates
      under 5,000 tokens. Send a new message after an agentic turn of 20K
      tokens or more: the first round shows `f_keep ≥ 0.99`.
