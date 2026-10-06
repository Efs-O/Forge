# Telegram replies from live agent sessions

Status: implemented in `c3391e5`, released with the concurrent browser fix in `0.16.88` (`409296d`), packaged and installed locally. The running VS Code window needs Reload Window to load the installed build. This plan closes the gap where `/codex hello` appeared in the Codex window and its answer never returned to Telegram. The same path applies to `/claude` and `/copilot`.

## Contract

- `/claude`, `/codex`, and `/copilot` accept a question from a paired private chat. The command is admitted to the durable remote queue under its Telegram message dedup key. Forge acknowledges admission and sends the selected session's final answer or a clear failure back through the remote outbox.
- `/tell <claude|codex|copilot> <message>` retains one-way behavior. It makes no promise of a reply.
- A running session may use `forge.sh remote-notify <agent> <exchangeId>` for a progress note or `forge.sh remote-ask <agent> <exchangeId>` to ask the owner a question. The latter waits for `/answer <question-id> <text>`. Agents never supply a chat id or bot token. The control route validates the live sender alias, the exchange's target, running state, and current authorization of the original chat.
- The scoped route accepts at most twenty notices/questions per exchange and one unanswered question at a time. After a reload, an `unknown` request can still relay a question or answer for its remaining twenty-minute recovery window.
- Observing sessions return their final turn directly. A user-opened session writes the existing mesh verdict artifact. The remote request id is the mesh exchange id, so a restart cannot silently generate a second exchange for the same Telegram message.
- A crash after admission leaves a running request `unknown`. Recovery reads a retained verdict without resending the prompt. After twenty minutes with no result, it sends an explicit unknown-outcome notice. A duplicate Telegram update never requeues the unknown request.

## State × lifecycle ledger

| State | Create | Normal completion | Duplicate and retry | Crash or restart | Unpair and expiry |
| --- | --- | --- | --- | --- | --- |
| Remote request with `sessionTarget` | Telegram admission writes it before cursor advancement | `finish` atomically records final state and one outbox reply | Dedup key returns the existing request; no second agent turn | Dead running claim becomes `unknown`; recovery reads verdict or reports unknown after twenty minutes | Authorization blocks new delivery; queued requests remain under existing remote policy |
| Mesh exchange and verdict | Nonobserving `tell` uses the remote request id; observing `ask` runs through the alias FIFO | Verdict retained by mesh poller; remote drain reads it without consuming it | Fixed exchange id and unknown claim prevent redispatch | Retained verdict can finish an unknown remote request; no verdict produces an explicit unknown outcome | Existing mesh retention and authorization rules apply |
| Session question and remote answer file | Scoped `remote-ask` adds a question record and outbox prompt atomically; `/answer` writes a complete answer file | Waiting agent reads the file; answer text is recorded in remote state | A repeated `/answer` is handled without replacing the first answer | Durable question survives reload; a completed answer file remains available to the waiting agent | Question expires after twenty minutes; answer files are removed after one day; unpaired chats cannot answer or receive new asks |
| Question `outboxId` and `messageIds` (reply-to-answer) | `remote-ask` stores the id of the outbox item carrying the question, in the same mutation that queues it | Delivery records the provider message ids on the question, outside the try that owns delivery state; a reply to one of them answers it through the same path as `/answer` | Resending an item overwrites the ids with the latest send; a second reply is a duplicate answer, handled as `/answer` handles it | A crash between delivery and the record leaves no ids: reply-to-answer is lost for that question, `/answer <id>` still works | Removed with the question at expiry by `remoteStateRetention`; a reply to a pruned question falls through to an ordinary prompt |
| Remote outbox | Admission notice and final result use existing delivery machinery | Sent item is marked delivered | Retry may resend after ambiguous Telegram failure, per existing outbox policy | Pending or sending items resume on startup | `canDeliver` prevents delivery to an unpaired chat |

## Acceptance

- [x] All three aliases return a final answer to the same paired chat through the durable outbox in adapter tests.
- [x] User-opened Codex and Claude sessions use a retained verdict; a missing verdict times out visibly in tests.
- [x] Remote notify and ask are scoped to the originating exchange and refuse another alias or chat in tests.
- [x] `/answer` is bound to the original private chat, persists its result, and does not overwrite it on redelivery in tests.
- [x] Restart reconciliation never reasks the agent and does not lose a late verdict in tests.
- [x] A plain text reply to the delivered question message answers it; replies in another chat, to another message, carrying a file, or starting with `/` do not, in tests.
- [x] Help and Telegram menu distinguish reply-capable commands from one-way `/tell`.
- [x] Release CI passed on `409296d`: 431 test files passed, 7 skipped; 4,445 tests passed, 41 skipped. `npm run package` passed and produced `forge-llm-0.16.88.vsix` (12,275,608 bytes, SHA-256 `F706782C2E9F0FDFC32D7A4B7154629E41452DE2E0F94AF16C67EF6858879005`). The local VS Code CLI installed `efsoo.forge-llm@0.16.88`. This plan-only status edit followed packaging; `docs/**` is excluded from the VSIX, so the existing same-version package must not be rebuilt or overwritten.

## Limits to verify live

The automated tests use fake Telegram and session adapters. A real Telegram round trip for each installed CLI adapter, a real intermediate `remote-ask`, and an ambiguous Telegram send failure still need live verification. The existing remote outbox is at least once, so an ambiguous network send can duplicate a visible notice; the agent request itself is deduplicated.

The agent-bus client uses the endpoint of the focused Forge window. If focus moves to a different workspace's window while an exchange is active, a scoped ask/notify call refuses the unknown exchange there; it does not redirect to another chat. The caller can retry after returning focus to the owning window. Native `/stop` still targets Forge model turns, not a CLI session's remote ask.
