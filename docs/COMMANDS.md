# VS Code commands

Every command Forge contributes to the palette. This lived in `README.md`,
which is also the Marketplace and Open VSX Overview page: a forty-row table of
command ids is reference a user looks up once and a store visitor scrolls past
forever. It was 10.6% of that page.

These commands are currently contributed by the extension.
`test/unit/CommandsDocDrift.test.ts` fails CI when this table and
`package.json` disagree. Telegram slash commands are a different surface; see
[remote control](REMOTE_CONTROL.md).

### Core sidebar and backend

| Command                       | Description                          |
| ----------------------------- | ------------------------------------ |
| `Forge: Open Sidebar`         | Open the Forge sidebar               |
| `Forge: Start Backend`        | Start the active backend             |
| `Forge: Stop Backend`         | Stop the active backend              |
| `Forge: Show Backend Console` | Reveal backend logs or console       |
| `Forge: Restart Backend`      | Restart the managed backend          |
| `Forge: Show Live Claude Sessions` | Copy a live Claude Code session id to link it to the intended Forge chat with `/link` |
| `Forge: Set Up Agent Note` | Write or update Forge's marked agent-mesh section in this workspace's `AGENTS.md` and `CLAUDE.md`, so other coding agents there know how to reach Forge chats. A missing `CLAUDE.md` is created holding only a one-line `@AGENTS.md` import, which is how Claude Code reads the section without a second copy of it; a `CLAUDE.md` that already imports `AGENTS.md` is left exactly as it is |
| `Forge: Add Agent Note to My User Files` | Put the same marked section in your own `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, creating either when missing and leaving your own lines beside it, so a Claude Code or Codex session started outside every Forge workspace still learns how to reach Forge chats. The text is workspace-neutral, this command is the only thing that ever creates those files, and a start refreshes only a section already inside its markers |
| `Forge: Connect to my desktop` | On a laptop: add every model the desktop offers to `config.yaml` in one comment-preserving write — the desktop's own models through its shared starter port, and the cloud models its relay allows, under the `ollama-cloud` / `desktop-relay` groups. Reads only, so a sleeping desktop stays asleep; writes no key; an entry that already exists is left exactly as it is |
| `Forge: Share this computer` | On the desktop: turn on `model_starter` and `cloud_relay` in `config.yaml` and share only those two ports with `tailscale serve`, after showing the exact commands and the switches in a dialog you confirm. Never shares 8799 or Ollama's 11434, never changes the ACL, Tailnet Lock or sign-in, and does nothing in a tunnel or SSH window |
| `Forge: Stop sharing this computer` | Turn off the two switches and the two `serve` shares Forge made, and leave every other share this computer has on the tailnet exactly as it was |
| `Forge: Check connection` | On a laptop: walk the path to the desktop — Tailscale here, the desktop online in Tailscale, the model starter, the cloud relay, the models the desktop will serve — and name the first link that is broken in plain words. Reuses the address probe that every prompt already uses, reads only, and starts nothing |
| `Forge: Open Config`          | Open the active config file          |
| `Forge: Show Memories` | Open the regenerated workspace memory index |
| `Forge: Validate Config`      | Validate the active config           |
| `Forge: Check Media Setup`    | Report configured media engines and missing paths |
| `Forge: Pick Model`           | Pick the active model                |
| `Forge: Pick GGUF Model File` | Pick a GGUF file during setup        |
| `Forge: Model Manager`        | Open the Model Manager panel         |
| `Forge: Add Models`           | Add model entries to the config      |
| `Forge: Compact config into groups` | Migrate the config into shared groups (comment-preserving) |
| `Forge: Move security settings to policy.yaml` | Move the policy keys and each model's server programs from `config.yaml` into `~/.forge/policy.yaml` (owner-run; backs up config.yaml first, refuses to overwrite an existing policy file) |
| `Forge: Lock policy.yaml` | Make `~/.forge/policy.yaml` read-only for this user, so Forge's own writers and accidental edits are refused (owner-run; Forge never locks on its own, and reports the permissions it read back afterwards). It does not stop a program running as you — you can always unlock it or replace the file |
| `Forge: Unlock policy.yaml` | Put `~/.forge/policy.yaml` back to the folder's default permissions so the owner's own tools and Forge can write it again (owner-run) |
| `Forge: Setup Wizard`         | Run the first-run or repair flow     |
| `Forge: Set Up With an AI Agent` | Copy a prompt that has your AI agent (Claude Code, Codex or Copilot) set Forge up from the shipped `AI_SETUP.md` |
| `Forge: Unload Active Chat's Model` | Release only the active chat's model |
| `Forge: Unload All Models`    | Stop all backends and release models |
| `Forge: New Chat`             | Open a new conversation tab          |
| `Forge: Clear Active Chat`    | Clear the active tab                 |
| `Forge: Undo Last Turn`       | Restore the previous checkpoint      |
| `Forge: Keep Changes`         | Accept the current checkpoint        |

### Control-server commands

| Command                                | Description                                  |
| -------------------------------------- | -------------------------------------------- |
| `Forge: Ensure Model (load on demand)` | Ask the control server to load a model       |
| `Forge: Release Model`                 | Ask the control server to release a model    |
| `Forge: Control Server Status`         | Show control-server status and active models |

### Tokens, search, and setup helpers

| Command                           | Description                         |
| --------------------------------- | ----------------------------------- |
| `Forge: Set Search API Key`       | Store a Tavily API key in SecretStorage |
| `Forge: Set Cloud Provider Token` | Store a cloud-provider bearer token |

### Remote control

| Command                                          | Description                                                     |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `Forge: Configure Remote Control`                | Pick a remote-control setup action                              |
| `Forge: Validate Remote Control`                 | Check the remote configuration and stored secrets               |
| `Forge: Set Telegram Bot Token`                  | Store the Telegram bot token in SecretStorage                   |
| `Forge: Pair Telegram Remote`                    | Pair the owner account with a one-time code                     |
| `Forge: Unpair Telegram Remote`                  | Remove the paired Telegram owner                                |
| `Forge: Set Up Telegram Authenticator`           | Enroll a TOTP authenticator (QR shown locally)                  |
| `Forge: Reset Telegram Authenticator`            | Replace the enrolled TOTP secret                                |
| `Forge: Disable Telegram Authenticator`          | Remove TOTP session locking                                     |
| `Forge: Set Remote Inactivity Timeout`           | Set when an unlocked remote session re-locks                    |
| `Forge: Generate WakeSleep Relay Secret`         | Create the HMAC secret shared with an always-on wake relay      |
| `Forge: Link WhatsApp Device (Experimental)`     | Link the experimental WhatsApp adapter                          |
| `Forge: Pair WhatsApp Remote Owner (Experimental)` | Pair the WhatsApp owner                                       |
| `Forge: Unlink WhatsApp Device (Experimental)`   | Unlink the WhatsApp device                                      |

### Editor and review helpers

| Command                                   | Description                                  |
| ----------------------------------------- | -------------------------------------------- |
| `Forge: Explain Selection`                | Explain the active selection                 |
| `Forge: Review Selection`                 | Review the active selection                  |
| `Forge: Generate Tests For Selection`     | Draft tests for the selection                |
| `Forge: Refactor Selection`               | Refactor the selection                       |
| `Forge: Run Explain Selection`            | Execute the explain flow immediately         |
| `Forge: Run Review Selection`             | Execute the review flow immediately          |
| `Forge: Run Generate Tests For Selection` | Execute the test-generation flow immediately |
| `Forge: Run Refactor Selection`           | Execute the refactor flow immediately        |
| `Forge: Explain Diagnostic`               | Explain an editor diagnostic                 |
| `Forge: Propose Fix For Diagnostic`       | Draft a fix for a diagnostic                 |
| `Forge: Run Fix For Diagnostic`           | Execute a fix flow for a diagnostic          |
| `Forge: Propose Fix For File Diagnostics` | Review diagnostics across the active file    |
| `Forge: Use Current File As Context`      | Prefill context with the current file        |
| `Forge: Use Selection As Context`         | Prefill context with the selection           |
| `Forge: Use Open Tabs As Context`         | Prefill context from open tabs               |
| `Forge: Pick Files For Context`           | Pick context files manually                  |
| `Forge: Draft Plan In Scratch Document`   | Generate a planning scratch doc              |
| `Forge: Draft Review In Scratch Document` | Generate a review scratch doc                |
