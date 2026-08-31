# Telegram, auto-compaction, and starting-context audit

Date: 2026-08-31
Release: Forge 0.14.1

## Result

The reported Telegram session problem was real, but Telegram was not the root
cause. The shared send pipeline skipped auto-compaction when a turn failed
because its remaining context could not hold another tool call. The screenshot
showed that exact failure: only 562 bytes of arguments fit before the retry was
cut off.

Forge now lets this recoverable failure reach the normal addressed
auto-compaction policy. When `auto_compact.enabled` is true, Forge compacts the
same conversation and resumes the same request. The fix works for Telegram,
the sidebar, and every other caller of the shared send pipeline.

Telegram also has durable queue steering, queue cancellation, a context command,
a native command menu, visible queue acknowledgements, and better privacy-safe
session diagnostics. No existing command or agent capability was removed.

## What was wrong and what changed

### 1. Context-exhausted failures skipped auto-compaction

The model loop correctly marked context exhaustion as an incomplete turn. The
next layer returned every failed turn immediately, before it called the
post-turn context policy. The compaction code therefore had the information it
needed but was never reached.

The send pipeline now treats the two known context-exhaustion failures as
recoverable. It evaluates compaction, and if compaction returns a continuation,
it runs that continuation under the same request-chain reservation and user
intent. Other provider failures still return unchanged.

An explicit context-exhaustion signal is now authoritative even if Forge cannot
resolve `num_ctx` for that model. Percentage-based compaction still requires a
known context window.

Changed:

- `src/sidebar/SendPipeline.ts`
- `src/sidebar/ContextBudgetPublisher.ts`
- `test/unit/SendPipeline.test.ts`
- `test/unit/ContextBudgetToolFilter.test.ts`

### 2. Queued Telegram messages gave no steering choice

The controller already knew a message's queue position, but Telegram discarded
that result. A message could sit behind a long turn with no reply explaining
how to redirect it.

Telegram now sends a short queue acknowledgement with the position and tells
the owner about `/steer <prompt>`. Rejected private-chat commands also receive
their reason. Group chats still receive no acknowledgement and remain blocked.

`/steer <prompt>` has these guarantees:

1. Forge saves the steering prompt durably first.
2. It suppresses any automatic continuation from the old turn.
3. It interrupts the active turn without unloading the model.
4. Steering prompts run before ordinary queued prompts.
5. Multiple steering prompts remain FIFO among themselves.
6. Existing ordinary queued prompts are not lost.

The optional `priority: steer` field is backward-compatible with old durable
request files.

Changed:

- `src/remote/RemotePromptAdmission.ts`
- `src/remote/RemoteRequestStore.ts`
- `src/remote/RemoteStoreSchemas.ts`
- `src/remote/types.ts`
- `src/sidebar/ForgeHostFacade.ts`
- `src/sidebar/SidebarProvider.ts`
- `test/unit/RemoteCore.test.ts`

### 3. New and improved Telegram commands

Added:

- `/steer <prompt>` — interrupt the active turn and prioritize a new prompt.
- `/drop <number|all>` — cancel queued prompts from this remote chat only.
- `/context` — show used, maximum, percentage, and remaining context tokens.
- `/commands` — alias for `/help`.

Improved:

- `/queue` labels steering prompts and explains `/drop`.
- `/status` counts only this remote chat's queued prompts.
- Telegram registers the main commands with `setMyCommands`, so they appear in
  the app's slash-command menu.
- Invalid private-chat commands now receive a visible rejection reason.

Queue records are marked cancelled, not deleted. This preserves their durable
history. A Telegram chat cannot use `/drop all` to cancel another transport or
another chat's queued work bound to the same Forge conversation.

Changed:

- `src/remote/RemoteSessionCommands.ts`
- `src/remote/RemoteCommandHandler.ts`
- `src/remote/TelegramChannel.ts`
- `test/unit/TelegramChannel.test.ts`

### 4. Session diagnostics without sensitive content

The metadata-only remote audit now records pairing, authentication challenges,
failed authentication, lockout, successful authentication, manual session
locking, and steering admission.

The Forge output log records these request facts:

- transport;
- request id;
- conversation id;
- steering or ordinary priority;
- starting and ending context totals;
- terminal outcome.

It does not log prompts, responses, attachments, file paths, bot tokens, TOTP
codes/secrets, or raw Telegram identities.

Queue execution was moved to `RemoteQueueDrain.ts`. Normal/steering admission
was moved to `RemotePromptAdmission.ts`, and session/queue commands were moved
to `RemoteSessionCommands.ts`. This reduced the main controller from more than
400 lines to under 300 and the command handler to under 350.

### 5. Starting context was reduced without removing tools

The earlier exact Qwen tokenizer measurement found 13,023 static tokens before
the conversation:

| Component | Before | After | Difference |
| --- | ---: | ---: | ---: |
| System prompt | 2,672 | 2,914 | +242 |
| 61 native tool schemas | 7,969 | 7,494 | **-475** |
| 6 HalluScribe schemas | 2,382 | 2,382 | 0 |
| Total | 13,023 | 12,790 | **-233** |

The system prompt increased during this work because related Forge guidance was
added concurrently. Holding that separate change constant, the tool catalog
saves exactly 475 Qwen tokens: 6.0% of native-schema cost. The largest savings
were:

| Tool | Before | After | Saved |
| --- | ---: | ---: | ---: |
| `ask_local_agent` | 793 | 697 | 96 |
| `monitor_execution` | 467 | 274 | 193 |
| `exec_command` | 412 | 331 | 81 |
| `read_file` | 247 | 212 | 35 |
| `write_file` | 184 | 149 | 35 |
| `append_file` | 173 | 138 | 35 |

All 61 native tools and all six currently enabled HalluScribe tools remain
available. Their argument shapes, limits, safety rules, and important operating
instructions are unchanged; only repeated prose was made concise. Conversation
history and compaction summaries were not shortened.

## Verification

Focused verification during implementation:

- 72 remote, Telegram, and send-pipeline tests passed.
- Strict TypeScript checks passed for the extension host and webview.
- ESLint passed.
- `git diff --check` passed.
- Exact Qwen tokenizer measurement passed and wrote the numbers above.

Final release verification:

- `npm run ci`: passed.
  - 176 test files passed; 4 skipped.
  - 1,458 tests passed; 14 skipped.
  - strict extension/webview TypeScript checks passed.
  - ESLint passed.
  - extension and webview production builds passed.
  - bundle-load smoke passed.
- `npm run package`: passed.
  - created `forge-llm-0.14.1.vsix`.
  - 27 packaged files.
  - 8,592,896 bytes (8.19 MB).
  - SHA-256: `421FF9578305C3F5F6BF4DB2173080784CFCC8CBBD21295119725285FCA9739C`.

The first full CI attempt exposed seven stale schema expectations after target
kind labels were removed during compression. The labels carry useful agent
information, so they were restored and the exact measurement was rerun. The
same attempt also included the local manual tokenizer benchmark in Vitest,
which made an unrelated five-second harness test time out under CPU contention.
The benchmark was preserved under a non-test filename; the canonical product
suite then passed unchanged.

## Remaining real-device checks

Automated tests cover durable ordering, interruption order, queue scope,
context recovery, menu registration, and Telegram acknowledgements. A real
phone should still confirm:

1. Telegram refreshes the command menu for the bot.
2. A long live turn is interrupted by `/steer` and the steering prompt runs
   before a previously queued ordinary prompt.
3. The target local model successfully finishes after automatic compaction.

These are provider/device smoke checks, not known code failures.

## Repository note

The unrelated untracked `test/scan-live-session.py` file was present during the
work and was preserved. It is not part of Forge 0.14.1. Related concurrent
`FORGE.md` guidance about truncation and auto-compaction was preserved and made
consistent with the implemented code.
