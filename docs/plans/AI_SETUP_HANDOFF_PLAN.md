# AI setup handoff

Status: implemented for 0.16.67 (2026-09-30).

## Problem

A user who installs Forge from the Marketplace or Open VSX gets a wizard that
covers one path: pick GGUFs or an Ollama model, write a starter config. Getting
beyond that (a llama.cpp build that fits the GPU, the control server, the
Claude/Codex mesh, Telegram, web search) means reading the README and the
GitHub docs, and several steps have traps that only this repo's own agents
know about, because they live in our gitignored CLAUDE.md / AGENTS.md /
FORGE.md: bare `bash` is WSL on Windows, Codex needs the MSI PowerShell 7,
`n_gpu_layers: -1` means auto-fit and not "all layers", the mesh needs the
control server.

Almost every user this extension is for already has Claude Code or Codex. Those
agents can do what a wizard cannot: read `nvidia-smi`, find the model files,
size the context to the VRAM that is actually free, and recover when a step
fails.

## Design

1. **`AI_SETUP.md`**, at the repo root, shipped in the VSIX (whitelisted in
   `.vscodeignore` next to `README.md`). Written for an agent, not a person:
   ordered steps, exact commands, and a check after each step that asks Forge
   itself (the control server on `127.0.0.1`), never the agent's own belief.
2. **`Forge: Set Up With Claude Code / Codex`** (`forge.setupWithAgent`),
   registered before config bootstrap so it works in setup mode, which is the
   case it exists for. It copies a one-paragraph prompt to the clipboard that
   names the installed file's absolute path, the workspace config path and the
   global config path. Setup mode offers it next to the wizard.
3. **Hard lines in the file**: secrets never go in `config.yaml` (the user runs
   the SecretStorage commands); human-only steps are handed back, not faked
   (BotFather, TOTP scan, UAC, logins, window reload); an existing config is
   backed up before it is replaced; no edits outside the config, the llama.cpp
   install folder, and `~/.claude/settings.json` only when the user asks for
   the mesh.

Not in scope: launching the CLI for the user. The prompt is copied, the user
pastes it into the agent they already trust with their machine. Forge spawning
an unrestricted agent to reconfigure itself is a bigger decision than this.

## Keeping it true

`test/unit/AiSetupDoc.test.ts`:

- every `forge.*` command id the file names exists in `package.json`;
- every `config/...` path it names exists in the repo (and so ships);
- `.vscodeignore` whitelists `AI_SETUP.md`;
- every top-level key of every `yaml` block is a key of the config schema;
- the backup-before-replace rule is present (the ledger row below).

## Acceptance criteria

- `AI_SETUP.md` is inside the packaged VSIX (`npm run package` smoke lists it).
- `forge.setupWithAgent` is in the Command Palette with and without a config,
  and the copied prompt contains three absolute paths that exist or are the
  intended config locations.
- `npm run ci` green, including `AiSetupDoc.test.ts`.
- First real dry run (Codex in a clean Windows Sandbox, no other context) is
  the follow-up; its findings go into `docs/FIRST_RUN_EXPERIENCE_REPORT.md`.

## State × lifecycle ledger

Forge itself writes no new durable state: the command only writes the
clipboard. The rows are what the user's agent writes by following the file.

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `.forge/config.yaml` (workspace or global) | agent writes it; an existing file is first copied to `config.yaml.bak` | user deletes it; Forge falls back to setup mode | `control_server.enabled: false` etc.; nothing to pause otherwise | Forge's watcher reloads only a file that parses and validates; a half-written file shows the validation error and keeps the running config; the `.bak` restores it | agent dies mid-setup: the file is either the old one, the `.bak`, or a complete new one; rerunning the prompt resumes from step 0 | none; config lives until edited |
| `%LOCALAPPDATA%\Forge\llama.cpp-<tag>\` (Windows llama.cpp build) | agent extracts after both SHA-256 digests match | user deletes old folders by hand; `install_llamacpp` never overwrites one | not applicable; unused unless `llama_server.binary` points at it | partial extract: `--version` check fails, folder deleted and re-extracted | a running `llama-server` locks the exe; Forge's `/unload` releases it before removal | none; kept for rollback |
| `~/.claude/settings.json` `crossSessionInbound: accept` | agent adds the one key, only when the user asked for the mesh and runs Claude in bypass-permissions | user removes the key | removing the key restores approval prompts for Forge's messages | agent edits via read-modify-write of valid JSON; an invalid file makes Claude Code report it on next start | not applicable; Claude reads it at start | none |
