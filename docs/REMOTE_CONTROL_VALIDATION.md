# Remote control real-device validation

This guide validates Forge 0.14.0 from a Windows computer and an iPhone. Start
with Telegram. It uses Telegram's official bot interface and needs only one
personal Telegram account. Treat the WhatsApp transport as an optional,
experimental follow-up.

Do not paste tokens, pairing codes, phone numbers, raw provider IDs, or
linked-device files into issues, screenshots, logs, or Git.

## What runs where

| Device | Required | Not required |
| --- | --- | --- |
| Windows computer | [Visual Studio Code](https://code.visualstudio.com/download), the Forge 0.14.0 VSIX, and the workspace to control | Telegram Desktop, WhatsApp Desktop, Docker, Python, Node.js, a public server, a webhook, port forwarding, or ngrok |
| Owner iPhone for Telegram | The official [Telegram app](https://telegram.org/apps) and your normal Telegram account | A second SIM/phone number or a Forge iOS app |
| Receiving iPhone for WhatsApp | The official [WhatsApp app](https://www.whatsapp.com/download) registered to a dedicated receiving number | WhatsApp Desktop or a Forge iOS app |
| WhatsApp owner device | A second private WhatsApp account on a different number, on an iPhone or Android phone | It does not have to be another Windows computer |

Forge itself runs only inside VS Code on Windows. The phone is a remote control,
not the execution host. Keep Windows powered on, online, unlocked enough for VS
Code to keep running, with the intended workspace open. Closing VS Code,
sleeping Windows, or losing internet connectivity stops live remote control.
Only normal outbound internet access is required; do not open inbound router or
firewall ports.

Install the VSIX on Windows from **Extensions > ... > Install from VSIX...**,
select `forge-llm-0.14.0.vsix`, and run **Developer: Reload Window**. You do not
need to install Baileys, Telegram libraries, or any other package separately;
the transport code is bundled with Forge.

## Before configuring a provider

1. Open the workspace to be controlled in exactly one VS Code window.
2. Open the Command Palette with `Ctrl+Shift+P` and run
   `Forge: Configure Remote Control`, then choose **Open Forge config**.
3. Add this block to `.forge/config.yaml` at the workspace root. Preserve the
   rest of the existing configuration.

   ```yaml
   remote:
     enabled: true
     queue_limit: 5
     max_message_chars: 12000
     rate_limit_per_minute: 30
     telegram:
       enabled: true
     whatsapp:
       enabled: false
   ```

4. Save the file and reload the VS Code window if Forge does not apply the
   change automatically.
5. Run `Forge: Validate Remote Control`. Before provider setup, `owner=false`
   and `provider=false` are expected. There should be no unexpected queued,
   running, crash-unknown, pending, or abandoned records.

## Telegram: exact setup

### 1. Create the bot on the iPhone

1. Install or update the official Telegram app and sign in to the personal
   account that will own Forge.
2. In Telegram, open the official `@BotFather` account. Confirm the username is
   exactly `@BotFather`; do not send credentials to similarly named accounts.
3. Send `/newbot`.
4. Enter a display name, then a unique username ending in `bot`, as BotFather
   requests.
5. BotFather returns an HTTP API token. Copy it without posting or saving it in
   the workspace. Telegram documents this flow in its
   [BotFather guide](https://core.telegram.org/bots/features#botfather).

The bot does not need its own iPhone, SIM, or phone number. Your personal
Telegram account owns and messages it.

### 2. Store the token on Windows

1. In VS Code, run `Forge: Set Telegram Bot Token` from the Command Palette.
2. Paste the BotFather token into the hidden input and press Enter. Forge stores
   it in VS Code SecretStorage, not in `.forge/config.yaml`.
3. Confirm `remote.enabled: true` and `remote.telegram.enabled: true` in the
   config shown above.
4. Run `Forge: Validate Remote Control`. Require the Telegram line to show
   `configured=true`, `active=true`, `lease=true`, and `provider=true`.
   `owner=false` is still expected.

If the token is ever exposed, use BotFather's `/revoke` command, store the new
token with `Forge: Set Telegram Bot Token`, and do not reuse the old token.

### 3. Pair the owner iPhone

1. On Windows, run `Forge: Pair Telegram Remote`. Forge displays a command such
   as `/pair 12345678`; it expires after five minutes.
2. On the owner iPhone, open a **private chat** with the bot you created, tap
   Start if needed, and send the displayed command exactly.
3. Back on Windows, run `Forge: Validate Remote Control` again. Require
   `owner=true` as well as the four values from the previous step.
4. Send `/status` from the private bot chat. Forge should answer with the
   workspace/conversation status.

If pairing expires or the digits are mistyped, run the pairing command again
and use only the newest code. Pairing in a Telegram group is intentionally
rejected.

### 4. Validate Telegram behavior

1. Send `/new`, a harmless coding question, and a request that uses a read-only
   tool. Confirm FIFO responses arrive in the same private chat.
2. Trigger a Forge-native write approval. Confirm the private chat receives the
   approval buttons, resolve it once, and verify replaying the callback is
   rejected. Repeat once with VS Code resolving first and confirm the remote
   callback becomes stale.
3. Start a slow request, queue another message, and send `/stop`. Confirm only
   the current request is cancelled, the backend stays loaded, and the queued
   request subsequently runs.
4. Send from an unpaired Telegram account and from a group. Confirm neither can
   control Forge.
5. Open the same workspace in a second VS Code window. Confirm one window owns
   the Telegram lease and the other reports a visible ownership failure. Close
   the second window before continuing.

## WhatsApp: prerequisites and risk

The WhatsApp adapter uses the community Baileys library and is not an official
WhatsApp integration. WhatsApp warns that unofficial clients can put an account
at risk, including temporary or permanent bans. Use a dedicated receiving
number whose loss would be acceptable, and skip this section unless you accept
that risk.

WhatsApp needs **two distinct WhatsApp identities**:

1. **Receiving account:** the dedicated WhatsApp account that Forge links as a
   companion device. Its primary iPhone is used to approve the link.
2. **Owner account:** the private account from which you send Forge commands.
   It must use a different phone number because Forge ignores messages sent by
   the linked receiving account itself.

The clearest test setup is therefore one Windows computer, one iPhone holding
the dedicated receiving account, and a second phone holding the owner account.
The second phone may be iPhone or Android. Do not use your irreplaceable primary
WhatsApp number as the receiving account for this experimental validation.

### 1. Prepare the two WhatsApp accounts

1. Install or update official WhatsApp on the receiving iPhone and register the
   dedicated receiving number. The iPhone remains the primary device for that
   account.
2. On the second phone, install or update official WhatsApp and sign in to the
   separate owner number.
3. From the owner account, start a normal private chat with the receiving
   number so it is ready for the later `/pair` command.
4. Do not install WhatsApp Desktop on Windows for Forge; it is unrelated to the
   embedded adapter and is optional for your personal use.

### 2. Enable and link Forge on Windows

1. Change the transport section in `.forge/config.yaml` to:

   ```yaml
   remote:
     enabled: true
     queue_limit: 5
     max_message_chars: 12000
     rate_limit_per_minute: 30
     telegram:
       enabled: true
     whatsapp:
       enabled: true
   ```

   Telegram may be set to `false` if you want to test only WhatsApp.
2. Save the config. Run `Forge: Validate Remote Control`. WhatsApp should show
   `configured=true`, `active=true`, and `lease=true`; `provider=false` and
   `owner=false` are expected before linking.
3. Run `Forge: Link WhatsApp Device (Experimental)`.
4. Enter the **receiving account's** number using 7-15 digits, including the
   country code, with no `+`, spaces, parentheses, or leading international
   access prefix. For example, enter `15551234567`, not `+1 555 123 4567`.
5. Forge displays a temporary linked-device code.
6. On the receiving iPhone, open **WhatsApp > Settings > Linked Devices > Link
   a Device**. Choose **Link with phone number instead** if WhatsApp offers that
   choice, then enter the code shown by Forge. Labels can vary slightly by
   WhatsApp version.
7. Wait for the Windows notification that the connection opened, then run
   `Forge: Validate Remote Control`. Require WhatsApp `provider=true` in
   addition to `configured=true`, `active=true`, and `lease=true`.

If WhatsApp shows no phone-number option or rejects the code, update the iPhone
app from the App Store, run `Forge: Unlink WhatsApp Device (Experimental)`, and
start the linking sequence again. Do not repeatedly retry expired codes.

### 3. Pair the separate WhatsApp owner

1. On Windows, run `Forge: Pair WhatsApp Remote Owner (Experimental)`. Forge
   displays `/pair 12345678`; it expires after five minutes.
2. On the **second/owner WhatsApp account**, open the private chat with the
   receiving account and send that command exactly.
3. Run `Forge: Validate Remote Control` on Windows and require `owner=true`.
4. From that same owner chat, send `/status`, then a harmless prompt. Messages
   from any other account must be rejected.

### 4. Validate WhatsApp behavior

1. Repeat the Telegram functional checks. WhatsApp approvals use the exact
   `APPROVE <id>` or `DENY <id>` text shown by Forge rather than buttons.
2. Confirm group, newsletter, broadcast, unknown-JID, wrong-owner, and replayed
   approval messages cannot control Forge.
3. Run `Forge: Unlink WhatsApp Device (Experimental)`. Confirm validation
   reports the device unlinked and the owner revoked. On the receiving iPhone,
   check **Settings > Linked Devices** and confirm the Forge companion entry is
   gone. If it remains, tap it and log it out manually.

## Restart and delivery checks

Run these checks separately for every enabled transport:

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

## Acceptance record

Record only pass/fail, Forge version, transport, and timestamps. Never record
the token, phone number, owner/provider IDs, linking code, pairing code, or
linked-device credentials.

A release is accepted when every applicable check passes and `npm run ci` plus
`npm run package` remain green on the exact commit being tested.
