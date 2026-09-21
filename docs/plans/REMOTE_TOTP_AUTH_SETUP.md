# Forge Remote TOTP Setup

This guide sets up Forge remote control with Telegram and a Google
Authenticator-compatible TOTP app. Forge runs in VS Code on your computer; the
phone is only an authenticated control surface.

TOTP uses the standard RFC 6238 algorithm locally. Forge does not contact
Google or any other identity service.

## Before you begin

You need:

- VS Code with the Forge extension installed and reloaded;
- a Forge workspace with a valid `.forge/config.yaml`;
- a Telegram account and a Telegram bot token from `@BotFather`;
- an authenticator app, such as Google Authenticator, Microsoft Authenticator,
  1Password, Authy, or another RFC 6238-compatible app;
- the computer running VS Code kept online while you use remote control.

Do not paste a Telegram token, pairing code, TOTP secret, QR image, or current
six-digit code into the workspace, chat transcript, issue tracker, terminal,
or a screenshot.

## 1. Enable Telegram remote control

In the workspace configuration, add or update the `remote` block:

```yaml
remote:
  enabled: true
  queue_limit: 5
  max_message_chars: 12000
  rate_limit_per_minute: 30
  auth:
    # 0 disables inactivity expiry only. TOTP still locks on restart or /lock.
    inactivity_timeout_minutes: 30
  telegram:
    enabled: true
  whatsapp:
    enabled: false
  contacts:
    enabled: true
    web:
      enabled: false
      max_results: 5
      max_fetch_bytes: 200000
      timeout_ms: 15000
```

Set `remote.contacts.enabled` to `true` only if you want the existing Forge
Telegram bot to serve approved contacts in dedicated groups. Keep
`remote.contacts.web.enabled` false unless current-information lookups are
needed and the existing Forge search/fetch providers are configured.

Save the configuration. Forge normally reloads it automatically; reload the VS
Code window if the transport does not become active.

## 2. Create a Telegram bot and store its token

1. If you already have a dedicated Forge bot, reuse it. Otherwise, open the
   verified `@BotFather` account and send `/newbot`.
2. Copy the existing or newly created token only long enough to store it
   locally.
3. In VS Code, run **Forge: Set Telegram Bot Token**.
4. Paste the token into the hidden input.
5. Run **Forge: Validate Remote Control**.

The Telegram row should eventually report `configured=true`, `active=true`,
`lease=true`, and `provider=true`. `owner=false` and `totp=false` are expected
until the next two steps are complete.

If the token is exposed, revoke it through BotFather, store the replacement
with the same Forge command, and do not reuse the old token. Forge recreates
only the Telegram transport as soon as the replacement is stored; a window
reload is not required.

## 3. Pair the Telegram owner

Pairing establishes which Telegram account owns the remote control. It is not
TOTP authentication.

1. In VS Code, run **Forge: Pair Telegram Remote**.
2. Forge displays a temporary `/pair 12345678` command. It is valid for five
   minutes and can be used once.
3. From the intended owner's Telegram account, open a **private** chat with
   the new bot and send that command exactly.
4. Run **Forge: Validate Remote Control** again and require `owner=true`.

Group chats and other Telegram accounts cannot pair or control the Forge owner
session. Pairing alone has no second factor; once an authenticator is enrolled,
its session starts locked and pairing does not bypass it.

## 4. Configure BotFather for contact groups (optional)

Use the existing Forge bot. Do not create one bot per contact.

1. Open the verified `@BotFather` account.
2. Send `/setprivacy`.
3. Select the existing Forge bot.
4. Choose **Disable**.

This lets Forge receive ordinary, non-command messages in its dedicated
contact groups. It also means the bot can read all messages in any group where
it is a member, so add it only to private groups containing the owner, Forge,
and one approved contact. This setting does not expose private chats or groups
where the bot is not a member.

## 5. Connect an approved contact to a private group

The contact first opens the existing Forge bot privately and sends `/start`.
The owner approves the pending request from the authenticated private owner
chat. Then:

1. Create a new private Telegram group.
2. Add the existing Forge bot and the approved contact. Keep the group limited
   to those three participants.
3. In that group, the owner sends `/contact link <contact-name>`.
4. Forge posts a short link notice in the group and sends the one-time token to
   the owner's private bot chat.
5. In the private owner chat, send `/contact bind <token>`.
6. The contact can now ask ordinary questions in the group without mentioning
   the bot. Forge replies in the same group, and the owner can reply directly.

The contact's old private bot chat is an onboarding/status surface after
approval; ordinary contact questions there are rejected with a group notice.
Only `/owner <message>` escalates a contact request privately to the owner.
Forge never impersonates the owner. If Forge is offline, busy, using a
different active model, or has no free same-model capacity, the group receives
a generic unavailable message and the owner receives a rate-limited runtime
alert.

## 6. Optional contact web access

When both contact flags are enabled, the contact assistant may use only the
existing configured read-only web search/fetch providers. It cannot use Forge
files, shell, workspace tools, credentials, or messaging tools. Search and
fetch are bounded, HTTPS-only at the contact seam, and webpage text is treated
as untrusted data. If web access is disabled or unavailable, Forge must say so
instead of inventing current information.

## 7. Enroll an authenticator locally

Enrollment is deliberately a local VS Code action. Forge never sends the QR
code or Base32 secret through Telegram.

1. In VS Code, run **Forge: Set Up Telegram Authenticator**.
   You can also open **Forge: Configure Remote Control** and choose **Set up
   Telegram authenticator**.
2. Forge opens a disposable local webview containing a QR code and a manual
   Base32 key. It is not written to disk or an output channel.
3. In the authenticator app, add a new account and scan the QR code. Use the
   manual key only if scanning is unavailable.
4. Enter the current six-digit authenticator code in VS Code to confirm the
   enrollment.
5. Close the enrollment webview.
6. Run **Forge: Validate Remote Control** and require `totp=true` for
   Telegram.

The secret is stored in VS Code SecretStorage and bound to the paired Telegram
owner. It is never stored in `config.yaml`, remote durable state, or Forge
transcripts.

## 8. Authenticate from Telegram

After an extension restart, a `/lock`, inactivity expiry, or a new pairing,
the remote session is locked.

1. Send any ordinary text message to the private bot chat.
2. Forge replies that authentication is required.
3. Read the current six-digit code from the authenticator app.
4. Send that code as a message, or send `/auth 123456`.
5. Forge replies `Forge: authenticated.`
6. Send normal Forge commands or a coding request.

While locked, Forge consumes a six-digit code strictly as authentication input.
It never passes that message to a model, command handler, queue, approval
handler, or conversation binding.

## 9. Normal remote use

After authenticating, the paired owner can use normal remote control. Useful
commands include:

| Command                        | Behavior                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/status`                      | Shows bounded runtime, queue, notification, context, and approval state.                                                                         |
| `/new`                         | Binds the chat to a new non-active Forge conversation.                                                                                           |
| `/list [page]`                 | Lists conversations ten at a time with Previous/Next/Close buttons and short-lived absolute numeric selections.                                  |
| `/resume`                      | Continues the conversation currently bound to this chat, loading its model if needed.                                                            |
| `/select <number-or-id>`       | Selects and binds an existing conversation without starting a turn. `/resume <number-or-id>` remains an alias.                                   |
| `/models [page]`               | Lists configured models ten at a time with Previous/Next/Close buttons and absolute numeric selections.                                          |
| `/model <number-or-name>`      | Pins a model while the bound conversation is idle.                                                                                               |
| `/queue`                       | Lists durable prompts waiting for the bound conversation.                                                                                        |
| `/compact`                     | Compacts the bound conversation.                                                                                                                 |
| `/stop`                        | Cancels the active request only; queued requests remain queued.                                                                                  |
| `/unload`                      | Releases loaded backends while Forge is globally idle.                                                                                           |
| `/restart`                     | Restarts the bound conversation's explicitly pinned model while idle.                                                                            |
| `/workspace list [page]`       | Lists workspace aliases ten at a time, numbered, marking the one this chat is in.                                                                |
| `/workspace <number-or-alias>` | Hands the chat off to a configured workspace, by list number or alias, and continues its most recent conversation. `/new <n>` is a silent alias. |
| `/clanker on\|off`             | Changes the normal non-dangerous tool confirmation gate for this window.                                                                         |
| `/lock`                        | Immediately locks the remote session.                                                                                                            |
| `/timeout`                     | Shows the inactivity timeout.                                                                                                                    |
| `/timeout 30`                  | Sets a 30-minute timeout. Valid range is 1–1440.                                                                                                 |
| `/timeout off`                 | Disables only inactivity expiry. Restart and `/lock` still require TOTP.                                                                         |

`/timeout` is accepted only after TOTP authentication. It updates the same
configuration value used by the local extension and does not restart the
transport or cancel a running request.

Tool approvals are shown in VS Code and, while authenticated, in Telegram.
After `/lock`, expiry, re-authentication, or restart, an old approval button is
stale and cannot resolve an approval. Forge may leave an old Telegram button
visible, but pressing it fails closed.

## 10. Inactivity, queues, and notifications

Every valid authenticated owner action refreshes the inactivity timer. Invalid
codes, messages from other users, provider noise, background model output, and
outbound delivery retries do not.

When the timeout expires:

- currently running agent work is not cancelled;
- new prompts, commands, and approvals are blocked until TOTP succeeds again;
- queued work remains durable but does not start;
- final responses and new remote approval details remain pending rather than
  being delivered to a locked chat;
- successful re-authentication resumes the bound queue in FIFO order and
  retries eligible pending notifications.

Restarting VS Code also starts locked. A request that was already running at a
host crash remains crash-unknown and is never replayed. Previously queued work
waits for the paired owner to authenticate again.

## 11. Reset, disable, and unpair

All recovery operations are local-only:

- **Forge: Reset Telegram Authenticator** creates a new secret and requires a
  fresh local confirmation code. Re-enroll the authenticator app.
- **Forge: Disable Telegram Authenticator** requires a local confirmation and
  removes the enrolled secret. It creates no Telegram bypass command.
- **Forge: Unpair Telegram Remote** removes the owner and its TOTP enrollment.
  Pair a new owner, then enroll an authenticator again before treating the
  connection as TOTP-protected.

If the authenticator device is lost, use the local reset command. Do not try to
recover through Telegram; that path intentionally does not exist.

## 12. Validation checklist

Before relying on remote control, confirm all of the following:

1. `Forge: Validate Remote Control` reports an active, leased, provider-healthy
   Telegram transport with `owner=true` and `totp=true`.
2. An unpaired account and a group chat cannot control Forge.
3. A locked paired account cannot run `/status`, `/new`, `/resume`, `/compact`,
   `/stop`, `/timeout`, or a normal prompt.
4. A valid authenticator code unlocks the session; an invalid code does not.
5. `/lock` blocks a subsequent prompt until a fresh code is accepted.
6. A remote write that requires Forge-native approval reaches both the local
   approval surface and the authenticated Telegram chat.
7. Reloading VS Code leaves the remote session locked and does not replay a
   previously running request.

## Troubleshooting

**The bot does not reply before pairing.** This is expected. Forge does not
disclose remote state to unpaired senders.

**The pairing command fails.** Generate a new code locally and send the exact
`/pair` command in a private bot chat before it expires.

**A valid authenticator code fails.** Check the phone clock, then wait for the
next 30-second code. Forge accepts the current step and a small adjacent-step
window for normal clock skew. Five failed codes temporarily lock attempts.

**Queued work does not start after restarting VS Code.** Authenticate to the
private bot chat first. This is the intended fail-closed behavior.

**No final message arrives after the session locks.** Authenticate again. Forge
keeps the notification pending instead of sending transcript-derived content to
a locked chat.

**TOTP setup is unavailable.** Pair the owner and ensure the Telegram transport
is active before starting local enrollment.
