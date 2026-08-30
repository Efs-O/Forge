# Remote Compaction Progress Notifications

**Status:** implemented; automated tests passed; real-device progress smoke remains pending
**Date:** 2026-08-30
**Scope:** Telegram/WhatsApp remote control + compaction
**Goal:** A user who sends a prompt through Telegram gets a `"Forge: working…"`
progress message while it runs. Today compaction is silent on that channel until
it finishes. This plan adds a `"Forge: compacting…"` notification for
**automatic** compaction, and a progress message for a **manual `/compact` sent
from Telegram**, so the user can tell compaction apart from a normal prompt.

No new config, no new channels, no schema migration. Two seams: the `/compact`
command handler (easy) and a sidebar→remote notification bridge for
autocompaction (medium).

> **v3 (final)** — revised after two independent review passes (Codex): v1
> rated 4/10 (11 issues, all fixed), v2 rated 8/10 (4 more, all fixed).
> The corrected design below is what is implemented. See "Review fixes
> applied" at the end.

---

## Pre-implementation behaviour (verified in source at the time)

- `RemoteController.drain()` (src/remote/RemoteController.ts:339) sends
  `'Forge: working…'` via `channel.sendProgress` before `host.send`, and edits
  that message to `'Forge: completed.'` in `finally`. `sendProgress` returns a
  provider message id (Telegram `message_id`) or `undefined` when the channel
  has no progress affordance. `RemoteController` owns a private
  `RemoteOutboxDelivery` (line 47/59) whose `kick()` is **not** reachable from
  `RemoteRuntime` or the store.
- `/compact` (src/remote/RemoteCommandHandler.ts:130) calls
  `host.compact(conversationId)` — a blocking summarization call (30s–minutes) —
  then sends one result message. No progress. `host.compact` can return
  `'skipped'` or `'failed'`, not only `'compacted'`.
- Autocompaction (src/sidebar/ContextBudgetPublisher.ts →
  `autoCompactionPolicy.runAddressedAutoCompact` →
  `SlashCommandHandler.compactConversation` → `runCompaction`) runs entirely in
  the sidebar/agent-loop world with **no** reference to the channel, outbox, or
  bindings.
- `runCompaction` (src/sidebar/CompactionService.ts:94) is the single owner of
  compaction execution. It posts a webview `notice` ("Compacting conversation…")
  and a `generationStarted`, runs the summarizer inside a `try` whose `finally`
  (line ~185) releases the busy flag, and **then** validates the summary
  (line ~197) — so "finished" must be emitted after validation, not in that
  `finally`.

## Design

Additive only. Every path is a no-op when remote is disabled or the
conversation has no binding.

### Data model — the compaction event

One event type, emitted by the compaction owner, consumed by the remote layer:

```ts
type CompactionTrigger = 'auto' | 'sidebar' | 'remote';
interface CompactionEvent {
  conversationId: string;
  phase: 'started' | 'finished';
  outcome?: CompactionOutcome;          // set on 'finished'
  trigger: CompactionTrigger;           // which path started it
  remoteOrigin?: { channel: string; chatId: string }; // set when trigger==='remote'
}
```

`trigger` is the key that makes de-duplication and the auto-failure policy
decidable without any in-memory "in-flight" guard.

### Change 1 — host event seam (sidebar → out)

1. **Facade** (src/sidebar/ForgeHostFacade.ts): add an optional sink, mirroring
   `addApprovalSink`:
   ```ts
   onCompactionEvent?(listener: (event: CompactionEvent) => void): { dispose(): void };
   ```
   `SidebarProvider` backs it with a listener set it owns.
2. **Emit dependency** (src/sidebar/CompactionService.ts): `runCompaction` only
   receives `CompactionDeps` — it has no access to the facade. Add
   `emitCompactionEvent?: (event: CompactionEvent) => void` to `CompactionDeps`
   and wire it where `SlashCommandHandler` is constructed
   (src/sidebar/SidebarProvider.ts), pointing at the same listener set.
3. **Emit points** (precise, to avoid lying about progress):
   - `started` — only **after** the split is valid (i.e. after the
     `if (!split) return 'skipped'` guard) and immediately before the
     summarization `try`. Pre-start skips/failures (streaming, missing conv,
     no split) emit **nothing**.
   - `finished` — exactly **one**, after `started`, carrying the true terminal
     outcome. Use an outer outcome-tracking `try/finally` around the
     summarization + validation + apply so every terminal path (compacted,
     failed validation, thrown prompt call) emits once. Do **not** emit in the
     existing inner `finally` (that runs before summary validation).

### Change 2 — remote subscription + delivery (in → Telegram)

1. **Store lookups** (src/remote/RemoteRequestStore.ts):
   - `notifyOutbox(channel, chatId, text): Promise<void>` — append a
     `RemoteOutboxRecord` (fresh `id`, synthetic `requestId: 'host-<uuid>'`,
     `state: 'pending'`, `attempts: 0`). This is a durable write only.
   - `bindingsForConversation(conversationId, channel?): RemoteBinding[]` —
     **reverse** lookup (the store only has `binding(channel, chatId)` today).
     Returns clones; a conversation may map to several chats/transports.
2. **Controller entry point** (src/remote/RemoteController.ts): add a public,
   channel-scoped method that the runtime can call, because `outbox.kick()` is
   private and a durable write alone does **not** wake an idle delivery loop:
   ```ts
   async enqueueHostNotification(conversationId: string, text: string): Promise<void>
   ```
   It calls `store.bindingsForConversation(conversationId, this.channel.name)`
   — **filtered to this controller's own transport** — then `notifyOutbox(...)`
   per matching binding and finally `this.outbox.kick()`. Filtering by channel
   is mandatory: with Telegram and WhatsApp both active, each transport runs its
   own subscription, and an unfiltered lookup would deliver every notification
   twice to every bound chat.

   **Optional facade:** `onCompactionEvent?` is optional on the interface. The
   runtime must use optional chaining and store an optional disposable:
   ```ts
   const subscription = host.onCompactionEvent?.(listener);
   ```
   so test fakes that omit the method keep working. Do not make it mandatory —
   that would force updating every facade fake for no gain.
3. **Runtime subscription** (src/remote/RemoteRuntime.ts): when a transport
   comes up, register `host.onCompactionEvent` and store the returned
   `{ dispose() }` in `ActiveTransport` (alongside `channel`, `controller`,
   `lease`). On `started`/`finished` for a bound conversation, call
   `controller.enqueueHostNotification(...)`. Dispose the subscription when the
   transport stops (before releasing the lease). Wrap async enqueue work in
   `void …catch(notifyLocal)` so a listener never produces an unhandled
   rejection. Register only after the controller/store is started.

**Why outbox, not `sendProgress`:** the autocompact event fires from the
sidebar on a different call stack than any remote command, with no provider
message id to edit. A fire-and-forget durable outbox notification is the
established pattern for host→remote "something happened" messages.

### Change 3 — `/compact` progress (Telegram manual)

In the `/compact` branch (src/remote/RemoteCommandHandler.ts:130):

1. Before `host.compact`, `sendProgress?.(chatId, 'Forge: compacting…')`
   (`.catch(() => undefined)`), keep the id.
2. Edit the progress message **from the outcome**, not always "complete":
   - `'compacted'` → `Forge: compaction complete.`
   - `'skipped'` → `Forge: compaction skipped.`
   - `'failed'` → `Forge: compaction failed.`
   The outcome is captured **before** the authoritative result `send`, and the
   progress edit is made from that captured outcome **regardless of whether the
   result send succeeds**. Only a throw from `host.compact` itself (no outcome
   available) edits to failed. This prevents a `channel.send` failure after a
   successful compaction from displaying a false "failed" state — wrap
   `host.compact` in its own try/catch, classify that error, and let the result
   send's failure flow through the existing command error path without touching
   the progress edit. Test: `channel.send` throws after a successful compaction
   → progress still reads "complete".
3. Pass `trigger: 'remote'` + `remoteOrigin` so the host event (Change 1) knows
   this compaction is remote-originated (see de-dup below). This requires
   extending the host `compact`/`compactConversation` options to carry the
   origin. The existing authoritative result message is unchanged.

### Delivery policy (the explicit rule the review asked for)

The host event is the **single** source of remote compaction notifications,
routed by `trigger`:

- `trigger: 'auto'` → notify on `started` ("compacting…") and `finished`
  ("compaction complete." / a failure line). This is the primary new capability.
- `trigger: 'remote'` → **suppress** the host-event notifications for that
  origin; the `/compact` handler's own progress message (Change 3) is the only
  thing the chat sees. This is race-free de-duplication — no in-memory
  in-flight guard, survives transport reconfiguration.
- `trigger: 'sidebar'` (a person compacts in VS Code) → **suppress** by
  default. Mirroring local actions to a remote chat is not requested; keep it
  off. (Trivial to enable later by flipping this branch.)

Auto-failure policy: for `trigger: 'auto'` a `finished` with `'failed'` sends a
short failure line; a `'skipped'` (e.g. not enough history) sends **nothing**
to match the existing "auto compactions shouldn't toast" rule in
`runCompaction`.

### De-duplication — resolved, no guard needed

Because the event carries `trigger` and `remoteOrigin`, the runtime needs no
in-memory "in-flight" state: a remote `/compact` emits events tagged
`remote`/origin, and the listener simply ignores `trigger: 'remote'` events
(the handler already sent progress). This fixes the v1 guard, which had no
owner or call path (`RemoteCommandHandler` calls `host.compact` directly,
bypassing the runtime).

## Edge cases

- **Remote disabled / no binding:** `bindingsForConversation` returns `[]` →
  `enqueueHostNotification` is a no-op. No error.
- **`sendProgress` unsupported:** `sendProgress?.` returns `undefined`; the
  edit is skipped. Autocompact still works via outbox.
- **Compaction skipped/failed:** outcome mapped to the right line (or nothing
  for auto-skipped). No false "complete".
- **Reload / reconfiguration mid-compaction:** a `started` notification already
  enqueued is durable — `RemoteOutboxDelivery` resumes it after restart. But a
  `finished` event emitted **after** `stopTransport()` disposed the subscription
  is never enqueued and is lost. This is an accepted limitation, not a bug: the
  guarantee is "already-enqueued items are delivered", not "every terminal
  completion survives transport restarts". The in-memory progress id (Change 3)
  is likewise lost on reload (documented `sendProgress` behaviour); the edit is
  best-effort and silently skipped.
- **Multiple bindings for one conversation:** `bindingsForConversation` +
  per-binding fan-out in `enqueueHostNotification` notifies every bound chat and
  both transports, not just one.
- **Listener lifecycle:** subscription stored in `ActiveTransport`, disposed on
  stop; async work `void …catch(notifyLocal)`; registered only after start.
- **Rate limiting:** one short message per bound chat; outbox delivery is
  already serialized and bounded.

## What is explicitly NOT changed

- `drain()`'s `'Forge: working…'` for normal prompts.
- `runCompaction`'s webview behaviour (notice, busy flag, non-destructive
  transcript) — only event emits are added.
- `auto_compact` config, thresholds, resume logic.
- No new config keys, channels, or schema migration (outbox shape exists).

## Implementation order

1. `RemoteRequestStore.notifyOutbox` + `bindingsForConversation` + unit tests
   (host item lands in `pendingOutbox`; reverse lookup returns all bindings).
2. `CompactionEvent`/`CompactionTrigger` types; `CompactionDeps.emitCompactionEvent?`;
   `ForgeHostFacade.onCompactionEvent?`; `SidebarProvider` listener set;
   precise emit points in `runCompaction`. Test: a listener receives exactly one
   `started` + one `finished` with the true outcome; nothing for pre-start skips.
3. `RemoteController.enqueueHostNotification` (write + `outbox.kick`). Test: an
   idle outbox is kicked immediately.
4. `RemoteRuntime` subscription in `ActiveTransport` + dispose on stop; delivery
   policy by `trigger`. Tests: auto fans out to all bound chats; remote-
   originated events suppressed; sidebar suppressed; stop disposes listener.
5. `RemoteCommandHandler` `/compact` progress + outcome-mapped edit (captured
   before the result send) + `trigger:'remote'` origin. Tests: one progress
   message, no bridge duplicate; result-`send` failure after success still ends
   progress as "complete".
   - Channel filter: `enqueueHostNotification` uses
     `bindingsForConversation(conversationId, this.channel.name)`; test that a
     conversation bound to both Telegram and WhatsApp gets exactly one
     notification per transport, not two.
6. `npm run type-check`, `npm run lint`, `npm test` (unit + integration,
   non-live).
7. Manual Telegram validation (REMOTE_CONTROL_VALIDATION.md): `/compact` shows
   "compacting…" → result; small `auto_compact.at` forces auto → notification.
8. Commit (implementation) → `npm run package` (VSIX).

## Acceptance

- Telegram `/compact` shows "Forge: compacting…" while summarizing, then the
  existing result message; the progress line ends as complete/skipped/failed to
  match the outcome.
- Crossing the `auto_compact` threshold produces a Telegram notification with no
  user action.
- Remote disabled, or conversation not bound → no remote messages, no errors.
- Normal prompts still show "working…", not "compacting…".
- No duplicate "compacting…" for a single Telegram `/compact` (remote events
  suppressed); a conversation bound to both Telegram and WhatsApp gets exactly
  one notification per transport, not two.
- Sidebar-manual compaction does not notify a remote chat (default policy).
- `npm run type-check`, `npm run lint`, and the non-live suite are green.

## Review fixes applied (v1 → v2)

1. `notifyOutbox` cannot wake delivery → added `RemoteController.enqueueHostNotification`
   that writes **and** calls the private `outbox.kick()`.
2. No reverse binding lookup → added `bindingsForConversation(conversationId, channel?)`.
3. Multi-binding fan-out missed → fan out per binding in the controller.
4. Event payload too thin → added `trigger` + `remoteOrigin`.
5. In-flight de-dup guard had no owner → replaced with `trigger`-based
   suppression (race-free, no shared registry).
6. `runCompaction` can't reach the facade → added `CompactionDeps.emitCompactionEvent?`.
7. "finished in finally" would lie → emit `started` only after a valid split,
   `finished` once after validation via an outer outcome-tracking try/finally.
8. Progress always edited to "complete" → map the edit from the outcome.
9. Accidental sidebar-manual notifications → explicit per-`trigger` delivery
   policy (sidebar suppressed by default).
10. Listener lifecycle underspecified → stored in `ActiveTransport`, disposed on
    stop, async work caught, registered only after start.
11. Tests too narrow → enumerated wake-up, fan-out, de-dup, terminal-ordering,
    no-completion-lie, and dispose tests in the implementation order.

## Second-review fixes (v2 → v3, final)

12. Cross-channel duplication → `enqueueHostNotification` filters
    `bindingsForConversation(conversationId, this.channel.name)` to its own
    transport, so each notification is delivered once per bound chat even with
    Telegram + WhatsApp active. Tested.
13. `onCompactionEvent?` optional vs required → keep it optional; runtime uses
    `host.onCompactionEvent?.(listener)` and stores an optional disposable, so
    facade fakes that omit it keep compiling.
14. False "failed" on result-send error → capture the outcome before the result
    `send`; edit progress from the captured outcome regardless of the send's
    success; only a `host.compact` throw edits to failed. Tested.
15. Overstated reload durability → guarantee narrowed to "already-enqueued items
    are delivered"; a `finished` event after subscription disposal is an
    accepted loss, not a bug.
