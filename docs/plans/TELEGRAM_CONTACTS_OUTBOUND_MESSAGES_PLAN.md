# Telegram Contacts and Approved Contact Messages — Implementation Plan

Status: implemented 2026-09-21. Source, focused tests, and the starter contact
instructions template are included; live Telegram verification remains manual.

## Goal

Add a small, Telegram-only contact surface to Forge:

- The paired Telegram owner can approve contacts who have used `/start`.
- Approved contacts have only the `contact_only` role.
- Contacts can send bounded, short-memory questions to Forge.
- Forge may prepare a reply, but the reply is sent to the contact only after
  the owner explicitly confirms it.
- The owner can also prepare a direct message to a known contact, with the same
  confirmation requirement.
- Contact traffic never enters an owner Forge conversation and never receives
  Forge tools, files, workspace data, model controls, settings, prompts, or
  internal details.

## Agreed runtime policy

### Model and capacity

The contact model is the current configured `config.active_model`. There is no
new model fallback in the first version.

- If the contact model is already serving and has a free `n_parallel` slot,
  contact work may run in another slot without interrupting the owner task.
- A different model is never loaded concurrently for contacts. Forge must not
  evict, stop, or interrupt an owner model to serve a contact.
- If the configured contact model is not ready, is not resident, the active
  owner work is using another model, or the model has no free request slot,
  Forge does not start contact generation and sends a polite busy/unavailable
  notice to the contact.
- The capacity decision must happen before model generation. The contact path
  must not call the ordinary evicting `BackendPool.acquire()` path in a way that
  can displace an owner model.

The code should preserve a future capacity seam so a later hardware upgrade or
smaller contact model can enable a second model without redesigning contacts.

### Contact prompt and language

Contact-only generation uses a separate owner-authored file:

```text
.forge/contact-instructions.md
```

This file is not part of the normal `FORGE.md`/`AGENTS.md` instruction chain.
It is loaded only for contact prompts and combined with a hard-coded safety
policy owned by Forge. The policy cannot be weakened by the Markdown file.

The contact prompt must:

- answer in the language used by the contact, including Greek when the contact
  writes in Greek;
- use only the bounded contact transcript and the current contact message;
- never use tools or access files, workspace state, Forge conversations,
  credentials, settings, model controls, prompts, logs, or other contacts;
- produce a draft answer for owner confirmation, not an independently sent
  message;
- never expose hidden reasoning or internal tool/status details.

The contact thread keeps short-term memory, bounded to the latest configured
number of contact/assistant messages. Unapproved drafts are not treated as
sent assistant history.

### Burst and response behavior

- Messages from one contact arriving within five seconds are coalesced into one
  request.
- At most four messages are accepted in one burst/window. Further messages get
  a neutral throttling response and do not start model work.
- A contact has at most one active generation/draft at a time. Additional
  messages are acknowledged and held for the next bounded batch rather than
  creating uncontrolled parallel work.
- Automatic status messages such as “Forge is thinking” and “Forge is busy” are
  transport status, not substantive answers. The actual contact answer always
  requires owner confirmation.

### Privacy and deny list

The contact-facing deny list is enforced in two layers: the contact prompt has
the rules, and the host-side contact service prevents the contact path from
obtaining the denied capabilities at all.

Contacts must never receive:

- the owner identity, owner messages, owner session history, or other contact
  messages;
- Forge conversations, transcript data, files, source code, workspace paths,
  tools, model names/controls, settings, or system details;
- credentials, tokens, secrets, prompts, instruction files other than the
  approved contact instructions, or audit/log contents;
- contact lists, pending requester lists, command inventories, or internal
  error details;
- the ability to send an external message, alter state, or change Forge
  configuration.

The owner preview is the final mandatory approval surface. The contact service
should also reject obvious sensitive output patterns (paths, credentials,
internal command/control syntax) before presenting a draft. This is a defense
in depth measure; the primary guarantee is that the contact model is never
given Forge capabilities or private Forge context.

### Logging

Use the existing metadata-only `RemoteAuditLog`. Add contact lifecycle events
for:

- unknown-user rejection and `/start` pending registration;
- owner approval, rename, disable, and duplicate-contact rejection;
- contact request accepted, coalesced, throttled, busy, unavailable, or failed;
- draft created and owner previewed;
- send confirmed, cancelled, expired, sent, failed, or ignored as duplicate;
- foreign/stale callback rejection.

Do not add raw message text, secrets, Telegram IDs, filesystem paths, or model
output to the audit log. Existing HMAC identity hashes and bounded metadata are
the logging format to preserve.

## Current extension points

The existing code already provides the relevant boundaries:

- `RemoteController.handle()` authenticates the paired owner before command,
  session, or agent admission. Contact authorization must be inserted before
  the ordinary non-owner rejection, with no fall-through into owner routing.
- `RemoteAuth` owns the paired owner identity and TOTP/session gate.
- `RemoteRequestStore` and `RemoteStoreSchemas` own the shared atomic remote
  state file at `remote-state-v2.json`.
- `TelegramInboundMapping` validates Bot API updates and decodes callback
  payloads.
- `TelegramChannel` owns Bot API sends, per-chat ordering, message editing, and
  inline approval keyboard transport.
- `RemoteApprovalBridge` demonstrates owner/chat-bound, nonce-aware, one-shot
  callback approval, but contact outbound approvals need their own durable
  state machine.
- `PromptRun` already supports a replacement system prompt and no tool list;
  it is the safest existing model-call primitive for an isolated contact
  prompt once its host facade is extended with the required options/capacity
  contract.
- `RemoteAuditLog` already records metadata-only, HMAC-hashed identities.

## Planned changes

### 1. `src/remote/RemoteStoreSchemas.ts` — durable contact state

Extend the existing remote state schema additively, preserving version 2 and
defaulting new arrays for older state files. Do not create a second persistence
file or store contact data in `config.yaml`.

Add validated records for:

- pending `/start` requests: stable id, Telegram user/chat IDs, timestamps,
  status, and owner disposition;
- contacts: stable id, display name, Telegram user/chat IDs, literal
  `contact_only` role, active/disabled status, and timestamps;
- bounded contact thread messages: contact/assistant role, text, timestamp, and
  contact id;
- outbound contact drafts: request id, contact id, owner id/chat id, recipient
  chat id, exact final text, created/expiry times, and status.

Outbound states are `pending`, `confirmed`, `cancelled`, `expired`, `sent`, and
`failed`. `confirmed` is the durable send claim: once a request reaches it, a
duplicate callback cannot send again. A crash between the Telegram send and the
final `sent` update must not automatically retry the message.

Bound all contact history and stale pending records during the existing store
mutation/retention path. Validate Telegram IDs, names, status values, message
lengths, and timestamps at the schema boundary.

### 2. `src/remote/RemoteRequestStore.ts` — atomic contact mutations

Extend the existing serialized mutation owner with methods for:

- finding/creating pending `/start` requests with duplicate user/chat checks;
- approving a pending requester with a normalized display name;
- listing active contacts and disabling/removing contacts;
- case-insensitive name lookup with multiple-match results;
- appending and reading bounded contact thread history;
- creating an outbound draft with a ten-minute expiry;
- atomically claiming `pending → confirmed`, cancelling, expiring, marking sent,
  and marking failed;
- ignoring repeated confirmation/cancellation attempts after terminal or
  already-claimed states.

Use `reloadFirst` for owner decisions and send claims so multiple Forge windows
cannot overwrite each other’s contact state. No contact operation may create a
normal remote conversation binding.

### 3. `src/remote/types.ts` — typed contact events and transport capabilities

Add a distinct validated inbound event kind for Telegram contact confirmation
callbacks. It must carry the callback id, owner/contact sender id, chat id,
message id, action (`send` or `cancel`), and an opaque request handle.

Do not overload the existing `approve`/`deny` event used by
`RemoteApprovalBridge`.

Add a strict optional channel capability for sending a typed inline-keyboard
message and clearing/answering its callback. Do not add a free-form JSON/string
blob argument. Non-Telegram transports remain unchanged and do not advertise
the capability.

### 4. `src/remote/TelegramInboundMapping.ts` — callback codec

Extend the callback parser with a short opaque contact-action format that stays
within Telegram’s 64-byte callback limit. Reject malformed, oversized, or
unknown contact payloads before they reach the controller.

Keep selection callbacks and existing Forge tool-approval callbacks unchanged.

### 5. `src/remote/TelegramChannel.ts` and `src/remote/FakeRemoteChannel.ts` —
Telegram presentation

Add a typed Telegram send method for the contact preview:

```text
Ready to send to <contact>:

<exact text>

[Send] [Cancel]
```

Only the first message chunk may carry the buttons. Clear the keyboard and
answer the callback after a decision. Use the existing per-chat send queue and
Bot API error handling. Never put the recipient’s Telegram ID or message text
in callback data.

Add fake-channel capture for keyboard payloads and callback cleanup so unit
tests can assert the exact transport contract.

### 6. `src/remote/ContactInstructionsLoader.ts` — separate Markdown prompt

Create a focused loader for `.forge/contact-instructions.md`:

- resolve only inside the active workspace;
- reject symlinks that escape the workspace;
- apply an explicit byte limit;
- distinguish missing, unreadable, and loaded states;
- reload safely when the file changes;
- never merge the file into the normal `FORGE.md` instruction chain.

The implementation provides `config/contact-instructions.example.md` as a
starter template, but never overwrites an existing owner-authored file.

### 7. `src/remote/ContactPolicy.ts` — pure contact policy

Keep deterministic policy separate from transport orchestration. This module
should own:

- `contact_only` authorization checks;
- normalized display-name lookup rules and disambiguation wording;
- unknown-user neutral responses;
- five-second burst coalescing and four-message burst limits;
- automatic status wording that does not reveal internal details;
- the hard contact system-policy text and obvious sensitive-output checks;
- language-matching instruction text.

The policy must not decide owner authorization by itself; `RemoteAuth` remains
the owner of paired-owner identity and authentication.

### 8. `src/remote/TelegramContactService.ts` — contact workflow owner

Add the Telegram-specific coordinator for:

- pre-auth `/start`, unknown-user rejection, and active-contact admission;
- owner-side pending-request approval and contact management;
- direct owner `/send` draft creation;
- contact request coalescing, utilization checks, and bounded contact history;
- invoking the isolated contact prompt;
- owner preview/confirmation/cancellation;
- confirmed Bot API delivery and terminal state updates;
- owner notifications for contact activity and failures.

The service must expose narrow methods to `RemoteController` and
`RemoteCommandHandler`; it must not become a second remote transport or a
second persistence owner.

Owner command surface for the first version:

```text
/contacts pending
/contacts list
/contact approve <pending-id> <display-name>
/contact disable <name-or-id>
/send <name>: <exact message>
```

Names are case-insensitive. Multiple matches return an owner-only
disambiguation listing stable short IDs; contacts never receive that data.
Normal natural-language owner prompts remain unchanged. No model tool is added
for arbitrary external sending in this version.

### 9. `src/remote/RemoteController.ts` — authorization and routing boundary

Add the service before ordinary non-owner rejection:

1. Validate private-chat scope and event shape as today.
2. Let the paired owner continue through the existing owner/TOTP path.
3. For non-owner Telegram text/callback events, let the contact service decide
   whether the sender is an active contact, a pending requester, or unknown.
4. Return a handled/rejected disposition without calling `admitRemoteText`,
   `handleRemoteCommand`, conversation binding, question handling, tool
   approval handling, selection handling, or model controls for contacts.
5. Route owner contact commands through the existing durable command handling
   convention after owner authentication.

Contact callback decisions must re-check the paired owner and callback-bound
chat/request before the atomic store claim. A callback from any contact or
other Telegram user is ignored and audited.

### 10. `src/remote/RemoteCommandHandler.ts`, `remoteHelpText.ts`, and
`TelegramChannel.ts` command menu — owner UX

Add the contact commands to the existing owner command conventions and help
text. Keep the Telegram command menu and `/help` synchronized. Contact users
must not receive the owner help text or command list.

### 11. `src/remote/RemoteAuditLog.ts` — contact audit events

Keep the existing metadata-only format and add contact action names/tests. Do
not expand the audit schema to store raw text. Contact request IDs may be used
as bounded correlation IDs; raw Telegram identities continue to be HMAC-hashed.

### 12. `src/sidebar/PromptRun.ts` — isolated prompt text and safe model use

Extend `PromptRunOptions` with an explicit system-prompt text/replacement path
for the loaded contact Markdown. This must be separate from the existing
template-name option and must not fall back to the normal Forge persona or
`FORGE.md` when contact mode is selected.

The contact prompt request must:

- use `config.active_model` explicitly;
- include no tool definitions and no attachments/files;
- strip hidden thinking from returned content;
- use a bounded output budget;
- expose generation failure to the contact service rather than silently
  returning an empty answer.

### 13. `src/sidebar/AgentLoop.ts`, `ForgeHostFacade.ts`, and
`sidebarFacadeWiring.ts` — host-owned contact prompt seam

Expose a narrow host capability for an isolated contact prompt instead of
letting the remote layer import or control `BackendPool` directly.

The host seam owns the utilization check and must atomically coordinate:

- configured default model identity;
- model readiness/residency;
- active owner model identity;
- the model’s `n_parallel` capacity;
- contact prompt reservations;
- cancellation and release on success, failure, or shutdown.

It must permit a contact request only when it can use the same model’s free
parallel slot. It must refuse a request that would load a different model or
evict an active one. This keeps model lifecycle ownership in the sidebar/backend
layers and prevents the Telegram layer from creating an unsafe second acquire
path.

Update `ForgeHostFacade` test fakes with the narrow capability; do not expose
the entire backend pool to remote code.

### 14. `src/remote/RemoteTransportManager.ts` — lifecycle wiring

Construct the Telegram contact service only for the Telegram transport and pass
it to `RemoteController`. Reuse the existing shared store, auth, channel,
host-facade, abort signal, audit log, and workspace root. Dispose timers,
instruction watchers, pending reservations, and contact prompt work when the
controller/transport stops.

Do not change WhatsApp behavior or create a WhatsApp contact implementation in
this first version.

## End-to-end flows

### Contact onboarding

1. Unknown private user sends `/start`.
2. The controller does not pair or authenticate the user.
3. The service records one pending requester by Telegram user/chat ID and sends
   a neutral private response.
4. The owner receives a metadata-safe notification and reviews
   `/contacts pending`.
5. `/contact approve` assigns a friendly name and creates an active
   `contact_only` record. Duplicate user/chat IDs are rejected.

### Contact question

1. Active contact sends text.
2. Authorization happens before any Forge session or agent routing.
3. Forge applies burst coalescing and the host capacity check.
4. If unavailable, the contact gets only a generic busy/offline response.
5. If admitted, the contact gets a generic thinking status while an isolated,
   no-tools prompt runs on a free `n_parallel` slot of the configured model.
6. Forge creates an owner-bound pending outbound draft containing the exact
   recipient and generated text, then sends the owner a preview.
7. Only the owner’s `[Send]` callback atomically claims and sends the text.
8. The contact thread records the assistant reply only after successful send.
9. Cancel, expiry, failure, stale callback, foreign callback, and duplicate
   callback paths never send the message.

### Owner direct message

1. Owner uses `/send <name>: <message>`.
2. The service resolves only active allowlisted contacts.
3. It rejects missing/ambiguous/disabled contacts without sending.
4. It stores a short-lived pending draft and shows the exact recipient/text.
5. Owner confirmation is required before the Bot API call.

## Tests to add or update

### Unit tests

- `test/unit/TelegramContacts.test.ts` (new): pending `/start`, duplicate IDs,
  approval/name assignment, case-insensitive lookup, ambiguity, disable,
  contact-only isolation, burst coalescing, throttling, language prompt,
  deny-list checks, and status wording.
- `test/unit/RemoteCore.test.ts`: owner/contact routing, isolated contact
  history, busy/unavailable behavior, draft creation, send/cancel/expiry, and
  duplicate-confirm prevention.
- `test/unit/RemoteHardening.test.ts`: unknown-user privacy, foreign callback
  rejection, owner binding, no session/tool/workspace access, and no different
  model loading/eviction.
- `test/unit/TelegramChannel.test.ts`: typed contact keyboard, callback size
  limits, callback decoding, button cleanup, and fake transport behavior.
- `test/unit/PromptRun.test.ts`: explicit contact system prompt replacement,
  no normal `FORGE.md` injection, no tools, bounded output, and thinking
  stripping.
- `test/unit/ContactInstructionsLoader.test.ts` (new): workspace containment,
  missing/unreadable files, byte limits, reload, and no overwrite.
- `test/unit/ForgeHostFacade.test.ts` / `test/unit/AgentLoop.test.ts`: the
  host-owned same-model capacity check, reservation release, and refusal to
  start a different model.

### Focused integration coverage

Add a fake-channel controller flow covering:

- `/start` → owner review → approval → contact message;
- owner preview → send/cancel;
- retrying the same callback and delivering the callback from another sender;
- active owner task on the same model with a free `n_parallel` slot;
- different active model and full same-model capacity;
- model failure and Telegram send failure.

## Manual Telegram verification

After implementation:

1. Have a new Telegram account press `/start`; verify it receives no owner
   access and the owner sees a pending requester.
2. Approve it as `Chara`; verify `/contacts list` and duplicate prevention.
3. Send a Greek message; verify the draft is Greek, the owner sees the exact
   preview, and nothing reaches Chara before confirmation.
4. Confirm once, press the button again, and press it from another Telegram
   account; verify exactly one delivery.
5. Cancel and allow a draft to expire; verify no delivery.
6. Run a long owner task on the configured default model and verify contact
   work uses a free `n_parallel` slot without interrupting it.
7. Switch the owner task to a different model and verify Forge does not load or
   evict a model for the contact; the contact receives a generic unavailable
   notice.
8. Send a four-message burst, then a fifth message; verify coalescing and
   throttling.
9. Stop/restart the backend and verify the contact receives an unavailable
   response when Telegram is still reachable. A fully stopped Forge process
   cannot actively send while offline; pending Telegram updates are handled on
   restart and must not be mistaken for successful processing.

## Completion gates

- [x] Every inbound Telegram event is authorized before any Forge session or
  agent routing.
- [x] Contact records and outbound drafts are schema-validated and atomically
  persisted.
- [x] Contacts cannot access owner commands, sessions, tools, files, settings,
  model controls, prompts, logs, or other contacts.
- [x] Same-model contact work uses only a free `n_parallel` slot.
- [x] Different-model loading/eviction is refused.
- [x] Every substantive contact-facing message requires owner confirmation.
- [x] Duplicate and foreign callbacks cannot send.
- [x] Logging is metadata-only and privacy-safe.
- [x] `npm run ci`, `npm run package`, `git diff --check`, and `git status` pass
  after the final implementation/test/plan edits.

## Implementation notes

- Contact state is exposed through `RemoteContactStore` and retention through
  `RemoteContactRetention`, keeping `RemoteRequestStore` under the 500-line
  lint boundary while preserving its single serialized persistence owner.
- The host contact seam pins the already-ready backend with the existing
  non-evicting delegation hold for the complete generation. It refuses cold
  starts, different active models, unknown standalone prompt activity, and
  exhausted parallel capacity.
- Missing `.forge/contact-instructions.md` is allowed: Forge still applies the
  built-in deny-list and contact-only policy. The example file documents the
  optional owner-authored additions.
