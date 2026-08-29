# Remote control

Forge remote control is optional and disabled by default. It does not expose an
Internet-facing Forge server: the extension process makes an outbound connection
to the configured messaging provider, and VS Code must remain running.

## Security model

- Only one exactly matched, stable provider user ID is paired per transport.
- Only private chats are accepted. Group and channel messages fail closed.
- Pairing uses an eight-digit, one-time code that expires after five minutes and
  stops accepting guesses after five failed attempts.
- Provider credentials, owner IDs, and pairing codes use VS Code SecretStorage.
  They never belong in `config.yaml`, workspace files, transcripts, or Git.
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
4. Run `Forge: Pair Telegram Owner` and send the displayed `/pair 12345678`
   command to the bot from a private chat before it expires.

Use `Forge: Configure Remote Control` for setup/status actions. To revoke access,
run `Forge: Unpair Telegram Owner` and rotate the bot token with BotFather if the
token itself may have been exposed.

Remote commands are `/help`, `/status`, `/stop`, `/new`, and
`/resume <conversation-id>`. `/stop` cancels the active addressed request; it
does not unload the model, and durable queued requests remain queued.

Telegram update offsets advance only after Forge has durably accepted, handled,
rejected, or recognized an event as a duplicate. Final-response notification is
separate from execution and uses an at-least-once outbox with bounded retries.

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
