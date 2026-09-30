# Forge setup — instructions for an AI coding agent

You are Claude Code, Codex, or a similar agent. The user installed the **Forge
LLM** VS Code extension and asked you to set it up on this machine. This file
ships inside the extension; the prompt that pointed you here gave you its path
and the two places Forge looks for its config.

Work through the steps in order. After each step, run its **Check** and report
the result before moving on. Ask the user before every optional section — do
not set up what they did not ask for.

## Ground rules

1. **No secrets in files.** API keys, bot tokens and cloud tokens never go in
   `config.yaml`, in git, or in your reply. Forge keeps them in VS Code
   SecretStorage; the user enters them with the Forge command this file names.
2. **Hand back what only a human can do**: VS Code window reloads, Command
   Palette commands, logins (`claude`, `codex login`, Ollama sign-in),
   Telegram/BotFather, scanning a QR code, UAC prompts. Say exactly what to
   click or type, then wait. Never claim one of these happened.
3. **Back up before you replace.** If a `config.yaml` already exists, copy it
   to `config.yaml.bak` first, and keep its comments when editing — users
   record VRAM measurements in them.
4. **Stay in scope.** Write only the Forge config, the llama.cpp install folder
   (step 2), and `~/.claude/settings.json` if the user asks for the mesh
   (step 7). Kill no process you did not start.
5. **Trust Forge, not yourself.** A step is done when its Check passes, not
   when the file looks right.

Where the extension is installed, `config/config.example.yaml` is the full,
commented reference for every config key, and `config/starter/*.yaml` are
minimal starting points. Read them instead of guessing a key.

## Step 0 — Survey the machine

Collect, and show the user in a short table:

- OS and shell. **On Windows, bare `bash` may be WSL, not Git Bash.** Use
  PowerShell, or Git Bash by full path (`C:\Program Files\Git\bin\bash.exe`).
- GPUs and **free** VRAM: `nvidia-smi --query-gpu=index,name,memory.total,memory.used --format=csv`
  (NVIDIA), `system_profiler SPDisplaysDataType` (macOS), or none.
- System RAM.
- Model files already on disk: search likely folders (Downloads, `~/models`,
  `~/.cache/huggingface/hub`, `~/.cache/lm-studio`, other drives) for `*.gguf`,
  excluding `mmproj-*` projector files. Note size and quantization from the
  filename.
- Is Ollama running? `curl http://127.0.0.1:11434/api/tags`
- Are `llama-server`, `claude`, `codex` on PATH? Is there an existing Forge
  config at either path the prompt gave you?

Then recommend **one** backend and tell the user why:

- **llama.cpp** — fastest and the most control; needs a GGUF that fits.
- **Ollama** — simplest if it is already installed and has models.
- **Cloud / CLI only** — no suitable GPU: an OpenAI-compatible provider, or
  Claude Code / Codex as the model (`provider: cli`).

A model fits when its GGUF size plus the KV cache for the context fits in free
VRAM with **at least 1 GB spare**. On Windows a GPU that runs out does not
fail; it pages to system RAM and slows to a crawl.

## Step 1 — Choose the config location

- **Workspace**: `<workspace>/.forge/config.yaml` — for this project only.
- **Global**: the global path from the prompt — for every workspace.

Default to global unless the user wants per-project settings. A workspace
config wins over the global one when both exist.

## Step 2 — llama.cpp backend (skip for Ollama / cloud)

Get a `llama-server` binary if none is on PATH:

- **Windows + NVIDIA**: from the newest release on
  `https://github.com/ggml-org/llama.cpp/releases`, download
  `llama-<tag>-bin-win-cuda-<ver>-x64.zip` and the matching
  `cudart-llama-bin-win-cuda-<ver>-x64.zip`. Check each file's SHA-256 against
  the `digest` field the GitHub releases API reports; stop if either is
  missing or different. Extract both into
  `%LOCALAPPDATA%\Forge\llama.cpp-<tag>\`. No admin rights needed.
- **macOS**: `brew install llama.cpp`.
- **Linux**: the release's Linux asset for the hardware, or build with
  `cmake -B build -DGGML_CUDA=ON && cmake --build build -j` for NVIDIA.

**Check:** `llama-server --version` prints a build number.

Write the config from `config/starter/llama-cpp.yaml`:

- `llama_server.binary`: absolute path to `llama-server`.
- One entry per model under `models:` with `name`, `provider: llama.cpp`,
  `gguf_path` (absolute), and `spawn:` settings.
- `spawn.n_gpu_layers: 999` when the model fits in VRAM. **Never `-1`**: on
  current llama.cpp that means "auto-fit", which silently leaves layers on the
  CPU.
- `spawn.num_ctx`: start at 32768 and go higher only if VRAM allows. If the
  user raises `n_parallel`, each conversation gets `num_ctx / n_parallel`.
- For a vision model, set the model's `mmproj_path` to its `mmproj-*.gguf`
  (see `config.example.yaml`).
- `active_model`: the model to start with.

## Step 3 — Ollama backend (skip for llama.cpp / cloud)

Start from `config/starter/ollama.yaml`. Use tags exactly as
`ollama list` prints them, `endpoint: http://127.0.0.1:11434`, and a `num_ctx`
the model supports. Ollama cloud models go through the local daemon once the
user has signed in with the Ollama CLI; Forge sends no key.

## Step 4 — Cloud or CLI models (only if asked)

- OpenAI-compatible providers (`xai`, `openrouter`, `openai`,
  `openai-compatible`): start from `config/starter/openai-compatible.yaml`.
  The user stores the key with **Forge: Set Cloud Provider Token**
  (`forge.setCloudToken`).
- Claude Code / Codex as a model: the user installs the CLI and logs in
  (`claude` once, `codex login`), then add
  `{ name: claude-code, provider: cli, cli: claude }` (same for `codex`) under
  `models:`. For delegation from Forge also set
  `permissions.agents.delegate: true`.
- **Windows:** Codex needs PowerShell 7 installed from the **MSI**; the
  Microsoft Store package does not work.

## Step 5 — Turn on the control server

Add this to the config. It binds to `127.0.0.1` only and is how you check the
setup (and it carries the agent mesh in step 7, which also needs
`agent_bus.enabled`):

```yaml
control_server:
  enabled: true
  port: 8799
```

Leave `permissions:` as the starter wrote it unless the user asks otherwise.
Every write, shell command and network call still asks the user for approval
at run time.

## Step 6 — Hand over, then verify

Tell the user to **reload the VS Code window** (Command Palette →
"Developer: Reload Window"), then run **Forge: Validate Config**
(`forge.validateConfig`). A config error is shown in VS Code; fix it and
repeat.

**Check**, from your shell (on Windows PowerShell use `curl.exe`, not `curl`):

```text
GET  http://127.0.0.1:8799/healthz        → {"ok":true}
GET  http://127.0.0.1:8799/models         → lists the configured models
POST http://127.0.0.1:8799/ensure  {"model":"<active_model>"}   → 200 once loaded
POST http://127.0.0.1:8799/chat    {"model":"<active_model>","messages":[{"role":"user","content":"Reply with the word ready."}]}
```

`/ensure` can take minutes for a large model. If it fails, the user runs
**Forge: Show Backend Console** (`forge.showBackendConsole`) and pastes the
`llama-server` output to you. Common causes: wrong path, CUDA runtime DLLs not
next to the exe, context too large for the VRAM.

If port 8799 was taken, Forge used another one and said so in the Forge
output channel; ask the user.

Then ask the user to open the Forge sidebar and send a first prompt.

## Step 7 — Optional: agent mesh (Forge ⇄ Claude Code ⇄ Codex)

Forge installs its message client at `~/.forge/agent-bus/forge.sh` and its own
notes in `~/.forge/agent-bus/README.md`; read that README rather than this
section for the command set. Requirements:

- the control server from step 5, and the bus itself, which is off by default:

  ```yaml
  agent_bus:
    enabled: true
  ```

- the CLIs installed and logged in (step 4);
- **Windows:** run `forge.sh` with Git Bash by full path
  (`& "C:\Program Files\Git\bin\bash.exe" ~/.forge/agent-bus/forge.sh ...`),
  not bare `bash`, which may be WSL;
- if the user runs Claude Code in bypass-permissions mode, add
  `"crossSessionInbound": "accept"` to `~/.claude/settings.json`, or messages
  from Forge wait for approval there. Ask first.

**Check:** `forge.sh who` lists Forge.

## Step 8 — Optional: Telegram remote control

All of it is done by the user; your part is the config and the instructions.

1. The user creates a bot with **@BotFather** (`/newbot`) and keeps the token.
2. The user runs **Forge: Set Telegram Bot Token**
   (`forge.remote.setTelegramToken`). Never ask for the token yourself.
3. You set, keeping any existing `remote:` settings:

   ```yaml
   remote:
     enabled: true
     telegram:
       enabled: true
   ```

4. The user runs **Forge: Pair Telegram Remote** (`forge.remote.pairTelegram`)
   and sends the shown `/pair ...` code to the bot in a private chat.
5. Recommended: **Forge: Set Up Telegram Authenticator**
   (`forge.remote.setupTelegramTotp`) and scan the QR with an authenticator
   app.

**Check:** the user runs **Forge: Validate Remote Control**
(`forge.remote.validate`) and sends `/status` to the bot.

## Step 9 — Optional: web search

The user stores a Tavily or Brave key with **Forge: Set Search API Key**
(`forge.setSearchApiKey`). You add the `search:` block (see
`config.example.yaml`) and set `permissions.net.search: true`.

## Finish

Report to the user:

- the config path, the backend, and the active model;
- the Check results, pass or fail, with the output;
- what you skipped and why;
- anything left for them to do.
