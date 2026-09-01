# Remote control

Forge remote control is optional and disabled by default. It does not expose an
Internet-facing Forge server: the extension process makes an outbound connection
to the configured messaging provider, and VS Code must remain running.

## Security model

- Only one exactly matched, stable provider user ID is paired per transport.
- Only private chats are accepted. Group and channel messages fail closed.
- Pairing uses an eight-digit, one-time code that expires after five minutes and
  stops accepting guesses after five failed attempts.
- Provider credentials and owner IDs use VS Code SecretStorage. Pairing codes
  and authenticated-session state exist only in memory. None of them belongs in
  `config.yaml`, workspace files, transcripts, logs, or Git.
- A locally enrolled Google Authenticator-compatible TOTP secret adds a second
  gate. It is owner-bound in SecretStorage; the authenticated session and its
  replay protection are memory-only, start locked after a reload, and lock
  again after the configured inactivity timeout or `/lock`.
- One fenced global-storage lease prevents two Forge windows from consuming the
  same transport. A window stops accepting input if it loses that lease.
- Durable prompts, deduplication records, bindings, provider cursors, and the
  notification outbox live in extension global storage. Terminal records are
  retained for 30 days, subject to bounded record caps. Prompts enter the normal
  Forge conversation transcript.
- The metadata-only audit contains timestamps, channel, action, request ID, and
  truncated hashes of provider identities. It excludes prompt/response text,
  secrets, tokens, filesystem paths, and raw provider IDs.

A remote request has the same authority as the selected Forge model locally.
Forge-native tools still use the normal approval gate, which can be resolved from
the authorized private chat or the VS Code UI; first resolution wins. A
`provider: cli` model retains that CLI's configured full-access behavior and its
internal permission prompts cannot be intercepted by Forge.

## Telegram setup

1. Create a bot with Telegram BotFather and copy its token.
2. Run `Forge: Set Telegram Bot Token`. The token is written to SecretStorage.
3. Enable `remote.enabled` and `remote.telegram.enabled` in Forge config, then
   save/reload the configuration.
4. Run `Forge: Pair Telegram Remote` and send the displayed `/pair 12345678`
   command to the bot from a private chat before it expires.
5. Recommended: run `Forge: Set Up Telegram Authenticator`, scan the local QR
   code, and confirm one current six-digit code. The QR and manual key are never
   sent through Telegram. After enrollment, send a current code whenever Forge
   challenges you; use `/lock` when you want to end the remote session.

Use `Forge: Configure Remote Control` for setup/status actions. To revoke access,
run `Forge: Unpair Telegram Remote` and rotate the bot token with BotFather if the
token itself may have been exposed.

Run `Forge: Validate Remote Control` for a credential-safe local report covering
configuration, active consumers, lease ownership, paired-owner presence,
provider reachability, durable request health, and notification delivery. The
complete release checklist is in
[real-device validation](REMOTE_CONTROL_VALIDATION.md).

Remote commands are `/help`, `/commands`, `/status`, `/context`, `/stop`,
`/steer <prompt>`, `/new`, `/list`, `/resume <number-or-id>`, `/models`,
`/model <number-or-name>`, `/queue`, `/drop <number|all>`, `/unload`,
`/restart`, `/compact`, `/lock`, `/timeout [1-1440|off]`, and `/clanker on|off`.
Telegram publishes the main commands in its native slash-command menu.
Workspaces are listed with `/workspace` (`/workspace <page>` pages, and
`/workspace list` still parses) and opened with `/new <number-or-alias>`. The
list marks the entry this chat is in and names the open folder underneath it;
`/status` reports the same workspace on its first line. `/stop` cancels the active
addressed request; it does not unload the model, and durable queued requests
remain queued. `/steer` first saves its prompt durably, interrupts only the
active turn, and runs before ordinary queued prompts. `/drop` changes queued
records to cancelled instead of deleting their durable history. `/clanker on`
removes the normal confirmation step for
non-dangerous Forge-native tools and should be used deliberately.

Telegram update offsets advance only after Forge has durably accepted, handled,
rejected, or recognized an event as a duplicate. Final-response notification is
separate from execution and uses an at-least-once outbox with bounded retries.
Replacing the token with `Forge: Set Telegram Bot Token` recreates only the
Telegram transport immediately; a VS Code reload is not required.

If a model exhausts the remaining output room, an enabled auto-compaction now
runs for the failed turn and resumes the same addressed request. This is shared
send-pipeline behavior, not a Telegram-only fallback. The Forge output channel
logs request/conversation ids, terminal state, and context totals to help
diagnose remote sessions; it never logs message content or authentication
secrets.

## WhatsApp status

WhatsApp is an experimental, separately opt-in linked-device adapter. Enable
`remote.whatsapp.enabled`, run `Forge: Link WhatsApp Device`, and enter the
locally displayed code under the receiving WhatsApp account's Linked Devices
flow. Use a dedicated receiving account (or a second account): Forge ignores
messages sent by the linked account itself to prevent notification loops. Then
run `Forge: Pair WhatsApp Remote Owner` and send the one-time `/pair` command
from the separate private account that will control Forge. `Forge: Unlink
WhatsApp Device` revokes both the linked device and remote owner.

Its dependency, license, runtime compatibility, encrypted authentication
persistence, risks, and rollback are documented in the
[adapter ADR](adr/WHATSAPP_REMOTE_ADAPTER.md). Enabling it does not change the
shared remote admission, authorization, queue, outbox, approval, or lease
semantics.
