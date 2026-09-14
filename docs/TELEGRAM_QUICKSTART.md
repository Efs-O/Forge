# Telegram remote control — 5-minute setup

This guide gets Forge talking to you through a private Telegram chat. It is the shortest setup path for a new user.

Forge does **not** open an Internet-facing port for Telegram. The VS Code extension connects **outbound** to Telegram, so your phone can be on Wi-Fi, 4G, or 5G. The computer running Forge must be online, VS Code must be running, and Forge remote control must be enabled.

For the full security model, command reference, queue behavior, remote wake details, and WhatsApp support, see [Remote control](REMOTE_CONTROL.md).

## Before you start

You need:

- Forge installed and working in VS Code;
- a Forge project/config that already loads normally;
- Telegram on your phone;
- about five minutes.

Do **not** put the Telegram bot token, paired Telegram user ID, or TOTP secret in `config.yaml`. Forge stores those in VS Code SecretStorage.

## 1. Create your Telegram bot

1. Open Telegram and start a private chat with **@BotFather**.
2. Send `/newbot`.
3. Follow BotFather's prompts to choose a bot name and username.
4. BotFather gives you a bot token that looks roughly like:

   ```text
   123456789:AAExampleToken...
   ```

Keep that token private. Anyone who has it can control the bot account.

## 2. Give the token to Forge

In VS Code:

1. Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux, `Cmd+Shift+P` on macOS).
2. Run **Forge: Set Telegram Bot Token**.
3. Paste the BotFather token when Forge asks for it.

The token is stored in VS Code SecretStorage. Do not paste it into `.forge/config.yaml`.

## 3. Enable Telegram remote control

Open your Forge config and make sure the remote section contains:

```yaml
remote:
  enabled: true
  telegram:
    enabled: true
```

If you already have a larger `remote:` block, keep its existing settings and only change these two `enabled` values.

Save the config. If your current Forge session does not pick the change up immediately, reload the VS Code window.

## 4. Pair your Telegram account

In VS Code:

1. Open the Command Palette.
2. Run **Forge: Pair Telegram Remote**.
3. Forge displays a one-time command similar to:

   ```text
   /pair 12345678
   ```

4. Open the bot you created in Telegram.
5. Send that exact `/pair ...` command in a **private chat** with the bot.

The pairing code expires after five minutes. Forge accepts one paired owner per transport, and Telegram group/channel messages are not accepted.

## 5. Recommended: add the authenticator lock

Pairing identifies which Telegram account may control Forge. TOTP adds a second lock on top of that.

In VS Code:

1. Run **Forge: Set Up Telegram Authenticator**.
2. Scan the locally displayed QR code with Google Authenticator or another compatible TOTP app.
3. Enter one current six-digit code to finish enrollment.

The QR code and manual TOTP secret stay local; Forge does not send them through Telegram.

After a VS Code reload, after `/lock`, or after the configured inactivity timeout, Forge may ask for a fresh six-digit authenticator code before accepting remote commands.

## 6. Test it

Keep VS Code open and send this to your bot from Telegram:

```text
/status
```

You should receive the current Forge/workspace status.

Then send a normal prompt, for example:

```text
Tell me which Forge model is active.
```

If the selected model is available, Forge should run the request just as if it had been started from the sidebar and return the result to Telegram.

Useful first commands:

```text
/help
/status
/system
/context
/models
/chats
/workspace
```

Telegram publishes the main commands in its native slash-command menu as well.

## Using Telegram away from home

Nothing extra is required for ordinary Telegram control. Your phone can be on another Wi-Fi network or on 4G/5G because the Telegram transport uses outbound Internet connections rather than a direct connection from the phone to your PC.

The PC still needs to be awake, online, and running VS Code/Forge. Waking or starting a sleeping/offline Forge machine is a separate remote-wake setup; see the remote-control documentation for the built-in wake-relay interface.

## If it does not work

### The bot does not answer at all

Check that:

- VS Code is still running;
- Forge loaded the project successfully;
- `remote.enabled` is `true`;
- `remote.telegram.enabled` is `true`;
- the bot token was entered with **Forge: Set Telegram Bot Token**;
- you are messaging the same bot whose token you configured.

Then run **Forge: Validate Remote Control** in VS Code. It reports configuration, active transport ownership, paired-owner state, Telegram reachability, durable request health, and notification delivery without printing credentials.

### Forge says the chat is not paired

Run **Forge: Pair Telegram Remote** again and send the new `/pair ...` command before it expires. Pair from a private chat, not a Telegram group or channel.

### Forge asks for a six-digit code

That is the optional TOTP lock. Enter the current code from the authenticator app you enrolled with **Forge: Set Up Telegram Authenticator**.

### You replaced the bot token

Run **Forge: Set Telegram Bot Token** again. Forge recreates the Telegram transport for the new token; a full VS Code reload is normally not required.

### You want to remove access

Run **Forge: Unpair Telegram Remote**.

If you think the bot token itself has been exposed, revoke/rotate it through BotFather as well.

## Next steps

Once the basic link works, see [Remote control](REMOTE_CONTROL.md) for:

- approvals and `/clanker`;
- conversation and workspace switching;
- attachments and voice;
- compaction and remote progress;
- `/sleep` and `/wake`;
- queueing, retries, and delivery behavior;
- the full security model.
