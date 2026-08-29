# Remote control real-device validation

Use this checklist after installing Forge 0.14.0. Do not paste tokens, pairing
codes, phone numbers, raw provider IDs, or linked-device files into issues,
screenshots, logs, or Git.

## Baseline

1. Keep the tested workspace open in exactly one VS Code window.
2. Run `Forge: Validate Remote Control`.
3. Confirm remote control and the intended transport are configured, the
   transport is active, its lease is owned, and no unexpected queued, running,
   crash-unknown, pending, or abandoned records are reported.
4. A provider can be healthy before an owner is paired. `owner=false` is
   expected until the private-owner pairing step succeeds.

## Telegram

1. Create a dedicated bot with BotFather. Run `Forge: Set Telegram Bot Token`,
   enable `remote.enabled` and `remote.telegram.enabled`, and save the config.
2. Run `Forge: Validate Remote Control`. Require `active=true`, `lease=true`,
   and `provider=true` for Telegram.
3. Run `Forge: Pair Telegram Remote`, then send the displayed one-time command
   from the private Telegram account that will own Forge.
4. Run validation again and require `owner=true`.
5. Send `/status`, `/new`, a harmless coding question, and a request that uses a
   read-only tool. Confirm FIFO responses arrive in the same conversation.
6. Trigger a Forge-native write approval. Confirm the private chat receives the
   approval buttons, resolve it once, and verify replaying the callback is
   rejected. Repeat once with VS Code resolving first and confirm the remote
   callback becomes stale.
7. Start a slow request, queue another message, and send `/stop`. Confirm only
   the current request is cancelled, the backend stays loaded, and the queued
   request subsequently runs.
8. Send from an unpaired account and a group. Confirm neither can control Forge.
9. Open the same workspace in a second VS Code window. Confirm one window owns
   the Telegram lease and the other reports a visible ownership failure.

## WhatsApp experimental adapter

WhatsApp requires a dedicated receiving account (or second account). The
controlling owner must be a separate private WhatsApp identity; Forge ignores
messages sent by the linked account itself.

1. Enable `remote.enabled` and `remote.whatsapp.enabled` and save the config.
2. Run `Forge: Link WhatsApp Device`, enter the receiving account's digits-only
   number including country code, and enter the displayed code in Linked
   Devices on that account.
3. Run validation and require `active=true`, `lease=true`, and `provider=true`
   for WhatsApp.
4. Run `Forge: Pair WhatsApp Remote Owner`, then send the one-time command from
   the separate private owner account. Validate again and require `owner=true`.
5. Repeat the Telegram functional checks. Approval responses must use the exact
   `APPROVE <id>` or `DENY <id>` text shown by Forge.
6. Confirm group, newsletter, broadcast, unknown-JID, wrong-owner, and replayed
   approval messages cannot control Forge.
7. Run `Forge: Unlink WhatsApp Device`. Confirm validation reports the device
   unlinked and the owner revoked, and confirm the linked-device entry is gone
   from the receiving account.

## Restart and delivery checks

1. With one request running and another queued, reload the VS Code window.
   Confirm the running record becomes `crash-unknown` and is never rerun, while
   queued work remains durable.
2. Temporarily disconnect provider connectivity after a request completes.
   Restore connectivity and confirm notification delivery retries without
   rerunning the Forge request. Validation must eventually show no pending or
   sending notifications; any exhausted item must be visible as abandoned.
3. Save the Forge config repeatedly while idle. Confirm only one consumer per
   enabled transport remains active and validation continues to report one
   owned lease.

Record only pass/fail, Forge version, transport, and timestamps. A release is
accepted when every applicable check passes and `npm run ci` plus
`npm run package` remain green on the exact commit being tested.
