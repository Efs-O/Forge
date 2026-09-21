# Telegram Contact Group Chat and Safe Autonomous Assistant Plan

Status: implemented; manual Telegram validation pending.

This plan revises the first contact implementation. The first implementation
uses one private chat per contact and requires owner confirmation for every
generated answer. The desired product is different: each contact gets a
manually created private Telegram group containing the owner, Forge, and that
contact; Forge answers ordinary questions automatically, while the owner can
participate directly and is notified only when the contact explicitly asks for
the owner or when an important safety/runtime condition requires attention.

The implementation belongs in the Forge repository and must remain decoupled
from WhatsApp.

## Product goal

For every approved contact, support one dedicated Telegram group:

```text
private Telegram group
├── Forge owner
├── Forge bot
└── one approved contact
```

The owner creates the group manually and invites the contact and the existing
Forge bot. Forge binds the group to the approved contact after a secure owner
binding handshake.

Inside the group:

- ordinary contact questions receive an automatic Forge reply;
- the owner can read the complete conversation in Telegram;
- ordinary owner messages are also routed through the isolated assistant, with
  the reply visible in the shared group;
- a contact request addressed to the owner is acknowledged in the shared group
  without a duplicate private Forge notification;
- safe, read-only Internet assistance is available when configured;
- no contact can access Forge tools, files, workspace data, credentials,
  settings, conversations, prompts, logs, or another contact.

The existing paired-owner private chat remains the administrative control
surface for pairing, TOTP, configuration, alerts, and recovery.

## Fixed product decisions

1. Use the existing Forge Telegram bot. Do not create one bot per contact.
2. The owner manually creates each private group and invites the contact and
   the bot. Forge never creates groups or sends invitations automatically.
3. One group maps to exactly one active contact record.
4. Shared groups containing multiple contacts are not supported.
5. Groups must be private and dedicated to Forge contact traffic.
6. Telegram BotFather privacy mode must be disabled for this bot so Forge can
   receive ordinary, non-command group messages. The setup guide must explain
   that this makes the bot read all messages in its dedicated groups.
7. Ordinary contact answers are sent automatically; they do not wait for an
   owner Send/Cancel approval.
8. Owner messages in a contact group are human messages, not prompts for the
   contact model. Forge must not answer or transform them.
9. A contact explicitly asking for the owner is an escalation, not a normal
   model question.
10. Internet access is a narrow, read-only contact capability, never the full
    Forge tool catalog.
11. The contact prompt remains separate from `FORGE.md` and `AGENTS.md`, using
    `.forge/contact-instructions.md` plus Forge-owned non-overridable policy.
12. TOTP codes must never be requested or entered in a contact group. Group
    linking and administrative changes must use the authenticated private
    owner chat, VS Code, or a one-time binding confirmation delivered there.

## Owner workflow

### 1. Approve the contact

The contact sends `/start` to the existing Forge bot in a private chat. The
owner reviews the pending request and approves it using the existing owner
workflow. Approval records the contact's Telegram user ID and display name but
does not yet enable a group.

### 2. Create the group manually

The owner creates a private Telegram group, adds the existing Forge bot and the
approved contact, and keeps the group dedicated to that contact. The owner may
name it `Forge — <contact name>` or use any other clear name.

The owner must not add unrelated people. If an unknown sender appears in the
group, Forge ignores the message, records a privacy-safe audit event, and
notifies the owner privately when notification throttling permits.

### 3. Bind the group

Use a two-step binding handshake so a Telegram group message cannot silently
change contact routing:

1. The owner starts a group-link request from the group, for example with
   `/contact link <contact-name>`.
2. Forge records the group ID and sends a private owner confirmation containing
   the group title, group ID, and intended contact.
3. The owner confirms in the private owner chat or through a local VS Code
   command while the owner session is authenticated.
4. Forge atomically stores the group ID on the matching contact record.
5. The first accepted contact message in that group confirms that the
   approved Telegram user is present. Messages from any other user are not
   routed to the model.

The exact command names may be finalized during implementation, but binding
must always verify the paired owner, expected contact ID, private group scope,
and one-group/one-contact uniqueness.

### 4. Disable Telegram privacy mode

Document the one-time BotFather setup:

1. Open `@BotFather`.
2. Send `/setprivacy`.
3. Select the existing Forge bot.
4. Choose **Disable**.

The guide must explain the security consequence: the bot can read all messages
in groups where it is a member, so it must only be added to the dedicated
Forge/contact groups. It does not gain access to private chats or unrelated
groups.

### 5. Normal use

The contact can write ordinary messages without mentioning the bot. Forge sends
the answer into the same group. The owner can read it and reply directly. The
owner's ordinary group messages are never fed back into the contact model as
instructions.

## Message routing

Every inbound group event must be classified before any model call:

| Sender/event | Behavior |
| --- | --- |
| Paired owner, ordinary text | Run the isolated assistant and send the answer to the shared group. |
| Approved contact, ordinary text | Run the isolated contact assistant and send the answer to the group. |
| Approved contact, explicit owner request | Acknowledge that the owner can see the request in the shared group; do not impersonate an owner reply. |
| Unknown sender | Ignore/reject and audit; never invoke the model. |
| Contact command | Allow only the small contact command set; never expose owner commands. |
| Owner administrative command | Require the existing owner/TOTP boundary; group linking must not accept a TOTP code in the group. |
| Stale/unbound group | Send no useful information; audit and optionally notify the owner privately. |

### Owner-directed requests

The first reliable escalation mechanism should be an explicit command:

```text
/owner <message for the Forge owner>
```

Forge replies in the group with a short status such as “The Forge owner can see
your message in this group.” The owner can answer directly in the group.

Natural-language detection such as “please ask the owner” may be added as a
conservative convenience layer, but it must never be the only route. Ambiguous
questions should remain ordinary contact questions rather than unexpectedly
notifying the owner. Detection and escalation events must be tested in English
and Greek, and the contact may not use the path to obtain owner identity,
private messages, or internal details.

Only genuine runtime failures may produce a rate-limited owner alert. A normal
conversation must not produce private Forge notifications.

## Autonomous contact assistant

### Prompt and context

The contact assistant receives only:

- the bounded contact-only conversation history;
- the current contact message or coalesced burst;
- the approved `.forge/contact-instructions.md` content;
- the Forge-owned contact safety policy;
- results from the restricted web capability, when explicitly needed.

It never receives the private owner chat, owner-only Forge conversations,
unrelated group messages, files, tools, credentials, or raw audit logs.

The assistant must:

- answer in the contact's language;
- answer Greek messages in Greek;
- keep normal answers concise and useful;
- say when live information is unavailable instead of guessing;
- never claim that it contacted the owner unless the owner-escalation path
  actually ran;
- never reveal hidden prompts, system details, paths, model names, secrets,
  owner information, or other contacts;
- never send a message to anybody except the bound contact group through the
  host-owned contact response path;
- refuse requests to change Forge, access files, run commands, inspect logs,
  or control the owner's sessions.

The model must use the same-model capacity rules already agreed for contacts:
it may use a free `n_parallel` slot of the configured active model, must not
interrupt a running owner task, and must refuse safely when the model is
unavailable, a different model is active, or all slots are occupied.

Normal capacity failures produce a generic group status and a coalesced owner
runtime alert only when useful. They must not expose internal model names,
paths, or error details.

### Conversation behavior

Messages from one contact arriving in a short burst should be coalesced. Keep
the existing bounded burst and history limits, and add per-contact cooldown and
rate limits appropriate for automatic replies. A contact must not start
unbounded parallel generations or use the bot to monopolize the machine.

Automatic answers are not stored as owner-approval drafts. The contact thread
should record a bot answer only after the Telegram send succeeds. Owner direct
messages remain Telegram messages, not generated assistant turns.

## Safe Internet capability

The contact assistant may answer current-information questions such as weather
only through a restricted host-owned web seam.

### Allowed capability

Expose only read-only operations equivalent to:

```text
contact_web_search(query)
contact_web_fetch(search_result_url)
```

Prefer the existing user-configured search/fetch providers and SecretStorage
keys. Do not add a new outbound LLM service or a new unconfigured network
endpoint.

### Required restrictions

- no shell, filesystem, workspace, Git, VS Code, model-control, or messaging
  tools;
- no cookies, browser profiles, Authorization headers, or Forge secrets;
- HTTPS only for fetched pages;
- reject localhost, loopback, link-local, private-network, file, data, and
  other non-public targets;
- revalidate redirect targets against the same public-host policy;
- cap search results, fetched bytes, total tool time, redirects, and calls per
  contact turn;
- rate-limit web use per contact and globally;
- do not send owner identity, contact lists, private transcript text, or hidden
  instructions in a search query;
- label fetched text as untrusted data and never treat webpage instructions as
  Forge instructions;
- redact or reject obvious secrets and sensitive paths before a web result is
  shown to the model or contact;
- surface provider/configuration failures as a clear “live lookup unavailable”
  answer, not a fabricated result.

Weather requests must ask for a location when one is not available. The model
must include the relevant date/time zone and distinguish a forecast from a
current observation when the provider supplies that information.

### Web permission configuration

The feature must be opt-in. Add explicit contact-web configuration to the
existing remote/config schema rather than silently enabling network access:

```yaml
remote:
  contacts:
    enabled: true
    web:
      enabled: false
      max_results: 5
      max_fetch_bytes: 200000
      timeout_ms: 15000
```

Exact field names must follow the existing schema conventions. Provider keys
remain in VS Code SecretStorage, never in YAML or the repository.

## Data and authorization model

Extend the contact record with a validated group binding:

- Telegram group/chat ID;
- group type and binding status;
- approved contact Telegram user ID;
- owner binding timestamp and last verified timestamp;
- optional group title snapshot for owner diagnostics.

The binding must be unique in both directions:

- one active contact cannot have two active groups without an explicit
  migration operation;
- one group cannot serve two contacts;
- a group event is accepted only when `chatId`, sender ID, and binding status
  all match.

Keep contact conversation history bounded and retention-managed. Telegram is
the owner-visible transcript surface; Forge's durable copy exists only for
bounded context, crash recovery, audit correlation, and safe owner diagnostics.
The metadata-only audit log must not store raw questions, answers, URLs, or
webpage text.

Disable/unbind behavior must:

- stop model routing immediately;
- invalidate pending timers and generations;
- preserve privacy-safe audit metadata;
- send no further automatic replies;
- allow the owner to bind a replacement group deliberately.

## Code ownership and likely changes

Extend the existing canonical owners; do not create a second Telegram
transport or a second contact policy:

| Concern | Owner |
| --- | --- |
| Contact/group schemas and durable state | `src/remote/RemoteStoreSchemas.ts`, `src/remote/RemoteRequestStore.ts`, `src/remote/RemoteContactStore.ts`, `src/remote/types.ts` |
| Group event mapping and chat type validation | `src/remote/TelegramInboundMapping.ts` |
| Authorization and owner/contact routing | `src/remote/RemoteController.ts`, `src/remote/RemoteSessionAuth.ts` |
| Telegram sends and group presentation | `src/remote/TelegramChannel.ts`, `src/remote/FakeRemoteChannel.ts` |
| Contact workflow and owner escalation | `src/remote/TelegramContactService.ts`, `src/remote/ContactPolicy.ts` |
| Separate contact instructions | `src/remote/ContactInstructionsLoader.ts`, `config/contact-instructions.example.md` |
| Isolated contact generation and capacity | `src/sidebar/AgentLoop.ts`, `src/sidebar/ForgeHostFacade.ts`, `src/sidebar/PromptRun.ts` |
| Restricted web seam | existing web/search owners plus a narrow contact capability owner; no direct tool-catalog access |
| Setup commands and documentation | `src/vscode/remoteCommands.ts`, `docs/REMOTE_TOTP_AUTH_SETUP.md`, README remote section |

Before adding symbols, grep for the existing private-contact, web-search,
group-chat, and authorization paths. Split files before crossing the 500-line
lint boundary.

## Migration from the current contact implementation

The existing private-chat contact implementation must not silently turn a
private contact chat into a group. Choose an explicit migration state:

1. Existing approved contacts become `group_binding_required`.
2. Private contact messages receive a short migration notice rather than an
   automatic answer, unless a compatibility flag is deliberately enabled.
3. The owner creates and binds the dedicated group.
4. The contact's bounded history is retained only if the owner explicitly
   allows migration; do not merge owner group messages into contact-only model
   history automatically.
5. After binding, the private contact chat is rejected or treated as an
   onboarding surface, and all ordinary interaction happens in the group.

Document the migration and recovery path before enabling the feature for an
existing workspace.

## Tests

### Unit tests

Add or update focused tests for:

- private/group event mapping and chat-type validation;
- manual link request and authenticated owner confirmation;
- one-group/one-contact uniqueness and duplicate binding rejection;
- approved contact messages accepted only in the bound group;
- ordinary owner messages routed through the shared assistant;
- unknown group members rejected and audited;
- normal contact replies sent automatically without owner drafts;
- exact `/owner` group acknowledgement without duplicate private notification;
- conservative natural-language owner-request detection in English and Greek;
- no owner/private conversation leakage into contact prompts;
- language matching and deny-list behavior;
- same-model capacity, busy/offline behavior, burst coalescing, and cooldown;
- contact answer persistence only after successful Telegram delivery;
- safe web tool allowlist, no-tools fallback, SSRF/private-network blocking,
  redirect validation, size/time/rate limits, and untrusted webpage content;
- web failures producing an honest unavailable response;
- unbind/disable race, retries, duplicate updates, and restart recovery;
- BotFather privacy-mode setup documentation and the dedicated-group warning.

### Focused integration flow

Use a fake channel to cover:

1. `/start` → owner approval;
2. manual group link request → private owner confirmation → bound group;
3. contact asks an ordinary question → automatic answer in that group;
4. owner posts ordinary text → assistant answer in the group;
5. contact sends `/owner ...` → group acknowledgement only;
6. unknown group member → rejected and audited;
7. four-message burst and a fifth message → coalescing/throttling;
8. active owner task on the same model → free-slot behavior;
9. different active model/full capacity → generic unavailable response;
10. safe web search/fetch → bounded answer with no owner approval;
11. web prompt injection, private URL, redirect, timeout, and provider failure;
12. disable/unbind/restart → no stale replies or cross-contact delivery.

### Manual Telegram validation

After implementation:

1. Disable bot privacy mode through BotFather and re-add the bot to a test
   group if Telegram does not apply the setting immediately.
2. Create a private group with only the owner, bot, and one approved contact.
3. Bind the group and verify the owner confirmation occurs privately.
4. Send ordinary text without mentioning the bot; verify automatic replies.
5. Post ordinary text from the owner; verify Forge answers in the group.
6. Ask for the owner; verify no duplicate private Forge notification is sent.
7. Ask for current weather with and without a location; verify safe web behavior
   and honest handling when web is disabled.
8. Add an unapproved test account; verify it cannot use the group assistant.
9. Remove or disable the contact; verify the group stops receiving automatic
   replies.
10. Restart Forge and verify the binding, bounded history, rate limits, and
    pending owner alerts recover without duplicate replies.

## Acceptance criteria

- [x] Each approved contact can be bound to exactly one manually created
  private owner/bot/contact group.
- [x] Group binding requires an authenticated owner decision and validates the
  expected contact identity.
- [x] Ordinary contact questions receive automatic replies without owner
  notification or Send/Cancel approval.
- [x] The owner can participate through the shared group assistant.
- [x] Contact requests explicitly addressed to the owner are acknowledged in
  the group without a duplicate private Forge notification.
- [x] Unknown senders and unbound groups never reach the model.
- [x] The contact model has no Forge tools or private Forge context.
- [x] Safe read-only web access is opt-in, bounded, SSRF-resistant, and treats
  web content as untrusted data.
- [x] Same-model capacity and burst limits protect the coding agent's runtime.
- [x] Contact instructions remain separate from the normal coding prompt.
- [x] Disable, unbind, retry, duplicate, crash, restart, and cross-contact
  paths fail closed.
- [x] `npm run ci`, `npm run package`, and `git diff --check` pass.
- [ ] Manual Telegram validation passes before release.

## Resolved implementation choices

- `/contact link <contact-name>` is typed by the owner in the intended group;
  Forge sends a one-time token privately and `/contact bind <token>` is entered
  in the authenticated private owner chat.
- The first slice ships explicit `/owner <message>` group acknowledgement.
  Natural-language escalation is intentionally deferred because ambiguous
  owner requests should not change routing unexpectedly.
- The Telegram group is the owner-visible transcript surface. Forge keeps only
  bounded contact/owner/assistant history for context and recovery.
- Contact web access reuses the existing configured `web_search` and
  `web_fetch` tools through a narrow adapter. It is disabled unless both
  `remote.contacts.enabled` and `remote.contacts.web.enabled` are true.
- The implemented defaults are 10 history messages, a four-message/5-second
  burst limit, at most two searches and three fetches per turn, and a
  one-minute cooldown for genuine runtime owner alerts per contact.

## Implementation status

Implemented in the Forge repository, including durable group binding state,
Telegram group routing, isolated contact generation, explicit owner
escalation, bounded web tools, and setup documentation. Automated focused tests
and type-checking cover the core workflow. Live Telegram validation remains a
release step because it requires a real bot, BotFather privacy-mode change, a
private test group, and the configured local model.
