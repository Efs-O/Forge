# Forge setup — instructions for an AI coding agent

You are Claude Code, Codex, or a similar agent. The user installed the **Forge
LLM** VS Code extension and asked you to set it up on this machine. This file
ships inside the extension; the prompt that pointed you here gave you its path
and the two places Forge looks for its config.

Work through the steps in order. After each step, run its **Check** and report
the result before moving on. Ask the user before every optional section — do
not set up what they did not ask for. Step 7 is not one of those sections: the
agent mesh ships on, and the note Forge writes into the workspace is part of it.

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
   (step 7). Forge writes the workspace agent note itself, so leave the user's
   `AGENTS.md` and `CLAUDE.md` alone — check what Forge put there, do not
   rewrite it. Kill no process you did not start.
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
`ollama list` prints them, set `endpoint: http://127.0.0.1:11434`, and choose a
`num_ctx` the model supports. Ollama cloud models go through the local daemon
once the user has signed in with the Ollama CLI; Forge sends no key.

## Step 4 — Cloud or CLI models (only if asked)

- OpenAI-compatible providers (`xai`, `openrouter`, `openai`,
  `openai-compatible`): start from `config/starter/openai-compatible.yaml`.
  The user stores the key with **Forge: Set Cloud Provider Token**
  (`forge.setCloudToken`).
- Claude Code / Codex as a model: the user installs the CLI and logs in
  (`claude` once, `codex login`), then add
  `{ name: claude-code, provider: cli, cli: claude }` (same for `codex`) under
  `models:`. `cli` is a bare name, or a full path to the executable. A `.cmd`
  shim is run through its launcher, which needs Node on PATH. For delegation
  from Forge also set
  `permissions.agents.delegate: true`.
- **Windows:** Codex needs PowerShell 7 installed from the **MSI**; the
  Microsoft Store package does not work.

## Step 5 — Check the control server

The new starter config enables the control server. If an older config lacks it,
add this. It binds to `127.0.0.1` only and is how you check the setup (and it
carries the agent mesh in step 7, which also needs
`agent_bus.enabled`):

```yaml
# partial: the control_server block only, not a whole config
control_server:
  enabled: true
  port: 8799
```

Use the port already recorded in the config, or choose an available loopback
port if you are adding the block yourself. Read `control_server.port` from that
same config for the checks in step 6 (8799 by default).

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
GET  http://127.0.0.1:<control_server.port>/healthz        → {"ok":true}
GET  http://127.0.0.1:<control_server.port>/models         → lists the configured models
POST http://127.0.0.1:<control_server.port>/ensure  {"model":"<active_model>"}   → 200 once loaded
POST http://127.0.0.1:<control_server.port>/chat    {"model":"<active_model>","messages":[{"role":"user","content":"Reply with the word ready."}]}
```

`/ensure` can take minutes for a large model. If it fails, the user runs
**Forge: Show Backend Console** (`forge.showBackendConsole`) and pastes the
`llama-server` output to you. Common causes: wrong path, CUDA runtime DLLs not
next to the exe, context too large for the VRAM.

If the port was taken, Forge reports the port it selected in the output
channel; ask the user which value to use.

Then ask the user to open the Forge sidebar and send a first prompt.

## Step 7 — Agent mesh (Forge ⇄ Claude Code ⇄ Codex): core, not optional

The mesh is how Claude Code, Codex and Copilot message, steer and stop Forge
chats, and every new starter config ships it on. Do not skip this step the way
you may skip something the user did not ask for. Forge installs its message
client at `~/.forge/agent-bus/forge.sh` and its own notes in
`~/.forge/agent-bus/README.md`; read that README rather than this section for
the command set.

**Read the state, do not guess it.** From the config you wrote, report
`control_server.enabled` and its port, `agent_bus.enabled`,
`permissions.agents.delegate`, and the path of every agent CLI you found
(`claude`, `codex`, `copilot`). If a switch is off, ask before turning it on:
the mesh is *inbound* — it lets other agents act on this workspace's Forge
chats — so enabling it is a trust change, not a preference. Requirements:

- the control server from step 5, and the bus itself (enabled in new starter
  configs; add it to older configs if absent):

  ```yaml
  # partial: the agent_bus block only, not a whole config
  agent_bus:
    enabled: true
  ```

- the CLIs installed and logged in (step 4);
- **Windows:** `forge.sh` is a bash script, and VS Code ships no bash on
  Windows — Git for Windows does — so look for it and check it exists before
  anything else: `Get-Command git.exe`, then
  `& "$(git --exec-path)/../../../bin/bash.exe"`, which is
  `C:\Program Files\Git\bin\bash.exe` for an all-users install and
  `%LOCALAPPDATA%\Programs\Git\bin\bash.exe` for a per-user one. Run the client
  through that path: `& "<that bash.exe>" ~/.forge/agent-bus/forge.sh ...`. If
  `Get-Command git.exe` finds nothing, say so plainly — the mesh client cannot
  run without Git for Windows — and offer `winget install --id Git.Git -e`;
  ask first, and never install unasked. Never fall back to bare `bash`: on
  Windows it may be WSL, and WSL's `$HOME` is not the Windows profile that
  holds `~/.forge/agent-bus`, so the client is not where that shell looks;
- if the user runs Claude Code in bypass-permissions mode, add
  `"crossSessionInbound": "accept"` to `~/.claude/settings.json`, or messages
  from Forge wait for approval there. Ask first.

Forge writes the agent note itself, so you do not have to. On the first start in
a workspace whose mesh is on, Forge adds one marked section
(`<!-- forge-agent-mesh:start -->` … `<!-- forge-agent-mesh:end -->`) to
`AGENTS.md` and `CLAUDE.md` — to every one of those two files that exists, or
creates `AGENTS.md` when neither does. It never touches text outside the
markers, never adds the section twice, and never deletes anything when the mesh
is later turned off. **Verify it instead of writing it:** read the file, confirm
exactly one marked section is there and that the user's own lines are untouched.
If it is missing — the mesh was only just turned on, or the write failed — have
the user run **Forge: Set Up Agent Note** (`forge.agentMesh.installNote`) and
check again. Say plainly what the section allows: local coding agents can now
message, steer and stop this workspace's Forge chats; `agent_bus:
{ enabled: false }` turns that off; deleting everything between the two comment
lines removes the note.

Approval rules stay owner-controlled. The owner can click **Allow for this chat**
on a card to remember its displayed action in that conversation; `/approvals`
lists the chat and matching project rules, and `/approvals reset` clears only
that chat's remembered rules. **Always in this project** is an owner button that
writes `approvals.always` through Forge; no agent tool can write
`~/.forge/policy.yaml`. If that file is locked, the rule remains chat-only. Jobs
and `--unattended` bus turns have no card and use only their owner policy allow
lists; an unmatched refusal names the exact line to add, so do not retry it.
The owner may set `permissions.approval_timeout_minutes`; 30 minutes is
suggested, but Forge adds no hidden timeout.

Read the complete usage header of the installed `forge.sh`; there is no `join`
command. `say` follows that agent's previously selected Forge chat, while
`send` to Claude, Codex or Copilot goes to that agent's session for that chat —
the one already linked, or a new one Forge starts and links if none exists — so
`who` shows what answered only after the send. Claude Code uses `say claude` and
`send claude <recipient>`; Codex uses
`say codex` and `send codex <recipient>`. A 202 exchange id confirms acceptance,
not an answer; read the verdict or failure before reporting success.
`stop <name> [--to <conversationId>]` cancels a running Forge turn like the
sidebar Stop button; `steer` interrupts and then runs its own text.
For a different Forge chat, use `say --to <conversationId>` or `--to-running`;
for a specific live Claude session, use **Forge: Show Live Claude Sessions**
to copy its id and `/link` in the intended Forge chat before `ask_agent`.

If several agents will work in the same project at once, tell the user they can
collide on files. Forge's starter `FORGE.md` already tells its own agent to check
`git status` for changes it did not make before editing, to stop and agree on
file ownership instead of undoing another agent's work, and to commit only named
files. Overlapping edits, or a full gate running while someone edits, need
separate worktrees and an agreed commit order; separate files and a short edit
can share one worktree. Offer the same rule for their `AGENTS.md` / `CLAUDE.md`;
add it only if they ask.

**Check:** `forge.sh who` reports the linked agent sessions held by open Forge
windows. An empty list is normal before any session is linked. Then the
end-to-end check that says setup is really done: start a **new** Claude Code or
Codex session in this workspace, give it nothing but the instructions in the
file Forge wrote, and have it run `who`, send `say --new` to a model you name
explicitly, and read the answer back with `view`. A session that cannot find
the bridge from that file means the note is not doing its job — say so, do not
paper over it by explaining the bridge to it.

## Step 8 — Optional: Telegram remote control

All of it is done by the user; your part is the config and the instructions.

1. The user creates a bot with **@BotFather** (`/newbot`) and keeps the token.
2. The user runs **Forge: Set Telegram Bot Token**
   (`forge.remote.setTelegramToken`). Never ask for the token yourself.
3. You set, keeping any existing `remote:` settings:

   ```yaml
   # partial: the remote block only, not a whole config
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

The user stores a Tavily key with **Forge: Set Search API Key**
(`forge.setSearchApiKey`). You add the `search:` block (see
`config.example.yaml`) and set `permissions.net.search: true`.

## Step 10 — Optional: image generation

`generate_image` appears only when an `image_generation:` block exists, and it
needs `permissions.net.fetch: true` (a local backend is fetched over localhost
too). Ask which route the user wants.

**Cloud (xAI Grok Imagine, billed per image).** The user stores an xAI key with
**Forge: Set Cloud Provider Token** (`forge.setCloudToken`). You copy the
`image_generation:` block with the `grok-imagine` backend from
`config.example.yaml`. Every call asks for approval.

**Local (stable-diffusion.cpp + Qwen-Image-2.1 Turbo, free per image).** Forge
does not ship the image server or the models; it starts `sd-server` when the
first image is asked for and stops it after `idle_timeout_ms`. Tested on
Windows with an RTX 3060 12 GB. It needs **one NVIDIA GPU with about 12 GB the
chat model is not using**. On a smaller or shared card, tell the user it is
untested and expect it to fail or to fall back to slow tiling.

1. **The server.** The tested build is release `master-929-3f8527a` from
   `https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-929-3f8527a`.
   Newer releases usually work; if one refuses a flag below or edits fail,
   use 929. On Windows + NVIDIA download both and extract them into **one**
   folder (for example `%LOCALAPPDATA%\Forge\sd.cpp-master-929\`):
   - `sd-master-3f8527a-bin-win-cuda12-x64.zip` — `sha256:217d6dead9abd3f827fc338268555cc179234e7e6330ef21ecb1c985e19d2dc7`
   - `cudart-sd-bin-win-cu12-x64.zip` — `sha256:fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d`

   Check each file's SHA-256 against these (the GitHub releases API reports
   the same `digest`); stop if either differs. The release has no Linux CUDA
   build: on Linux, build from source with `-DSD_CUDA=ON` (untested by us).
   **Check:** `sd-server.exe --help` lists `--vae-relative-tile-size`.

2. **The four model files** (about 11 GB), all from the official repos. Do not
   substitute a fine-tuned or "abliterated" text encoder: the vision file must
   match the text encoder, and `sd-server` exits within ~5 s when it does not.

   | config key | file | from |
   |---|---|---|
   | `diffusion_model` | `qwen-image-2.1-turbo-Q4_K_M.gguf` (4.2 GB) | `https://huggingface.co/unsloth/Qwen-Image-2.1-Turbo-GGUF` |
   | `text_encoder` | `Qwen3VL-8B-Instruct-Q4_K_M.gguf` (5.0 GB) | `https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF` |
   | `vision_encoder` | `mmproj-Qwen3VL-8B-Instruct-F16.gguf` (1.2 GB) | same Qwen repo |
   | `vae` | `vae/qwen_image_2.1_vae_bf16.safetensors` (0.7 GB) | `https://huggingface.co/Comfy-Org/Qwen-Image-2.1` |

   Download URL pattern: `https://huggingface.co/<repo>/resolve/main/<file>`.
   `vision_encoder` is optional for text-to-image but required for edits
   (`reference_paths`).

3. **The config.** Copy the commented `qwen-image-local` backend from
   `config.example.yaml` into `image_generation.backends`, fill in the five
   absolute paths, and set `image_generation.default` to it. Then:
   - `cuda_device`: the GPU's index in `nvidia-smi` (PCI-bus order), not the
     CUDA runtime's order. Pick the card the chat model is not on.
   - `min_free_vram_mb: 11200` and `max_vram_gib: 10.25` are starting values
     for a 12 GB card, not measured limits. Forge refuses to start the server
     when the card has less free than `min_free_vram_mb` — if a display is
     plugged into that card, read its free VRAM with `nvidia-smi` and set the
     value about 300 MB lower. On this machine's 12 GB card with the display
     moved to it, 10300 is what works (2026-10-23: at 11200 a busy desktop
     refused the render).
   - Keep `steps: 8`, `cfg_scale: 1.0`, `sampler: euler` and the `--sigmas`
     list in `extra_args`: the Turbo model is trained for exactly that 8-step
     schedule.
   - Keep `--vae-tiling --vae-relative-tile-size 2` in `extra_args`. Without
     them, on a 12 GB card every image after the first runs out of memory on
     the final decode and falls back to 55 small tiles (12-25 s instead of
     ~7 s, same picture). A server log line `VAE decode ran out of memory;
     retrying with spatial tiling` means these flags are missing; it is slow,
     not broken.
   - `idle_timeout_ms` must be at least `request_timeout_ms + 60000`.
   - `confirm_on_start: true` asks once before the GPU is occupied;
     `confirm_each: false` because local images cost nothing.

**Check:** after **Forge: Validate Config** and a window reload, the user asks
in the Forge sidebar:

> Generate a landscape image with seed 42: A wide green field in the
> countryside at sunrise, soft morning mist over the grass, wildflowers in the
> foreground, a single oak tree on a gentle hill, warm golden light, a dramatic
> sky full of big white cumulus clouds lit pink and gold by the rising sun,
> photorealistic landscape photograph

On an RTX 3060 it takes 40-45 s once the model files are in the disk cache,
and up to ~70 s the very first time; an edit with a reference picture takes
about 65 s. With the official files it should look like
[assets/readme/image-sample-green-field.jpg](assets/readme/image-sample-green-field.jpg)
(the same seed on a different GPU or build gives a similar, not identical,
picture). If the server fails to start, the user runs **Forge: Show Backend
Console** (`forge.showBackendConsole`) and pastes the `sd-server` output to you.
Common causes: CUDA runtime DLLs not next to `sd-server.exe`, a mismatched
vision file, a wrong `cuda_device`, or too little free VRAM.

## Step 11 — Optional: local video and music generation

Ask whether the user wants to set up local media generation. Skip this step if
they say no. It is off by default and does not download models.

If they say yes:

1. Inspect the available GPUs and free VRAM, then locate the existing ComfyUI
   checkout and Python interpreter, `ffmpeg`/`ffprobe`, LTX-2.5 model files,
   ACE-Step 1.5 runtime and checkpoints, and any Stable Audio 3 files. Use paths
   the user provides or likely model folders from Step 0; do not search personal
   media libraries.
2. Explain the engines before editing config:
   - LTX-2.5 is the video default. It uses one configured GPU; the example
     records 11 GB as its free-VRAM threshold. Its default is 5 seconds,
     1344×768 at 24 fps. Both dimensions must be multiples of 64.
   - MiniMax H3 is optional and runs only when the user asks for H3 by name. It
     needs one 16 GB Blackwell card, the configured UNET, and the upstream
     blueprint at `<ComfyUI root>/blueprints/Image to Video (MiniMax H3).json`.
     The example records a 15 GB free-VRAM threshold.
   - ACE-Step 1.5 makes tracks with or without vocals; Stable Audio 3 is
     instrumental only. Each uses one configured GPU and they run sequentially.
     The example gates each at 11 GB free VRAM. Stable Audio 3 Medium supports
     up to 380 seconds.
3. Name the model repositories: [Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5)
   and, for the Q8 GGUF used by this adapter, the community
   [Abiray/LTX-2.5-Distilled-GGUF](https://huggingface.co/Abiray/LTX-2.5-Distilled-GGUF);
   [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3);
   [ACE-Step/Ace-Step1.5](https://huggingface.co/ACE-Step/Ace-Step1.5) (ComfyUI's
   repackaged checkpoint is in
   [Comfy-Org/ace_step_1.5_ComfyUI_files](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files));
   and the post-trained
   [stabilityai/stable-audio-3-medium](https://huggingface.co/stabilityai/stable-audio-3-medium)
   plus its ComfyUI text encoder from
   [Comfy-Org/stable-audio-3](https://huggingface.co/Comfy-Org/stable-audio-3).
   Check each model's license and required files. Load the shipped
   `hf-download` skill if the user asks for download help; never start a large
   download without their explicit request.
4. Back up the existing config, then fill only the needed `media:` engine
   entries in `config.yaml`. Set the ComfyUI root, interpreter, model paths,
   `cuda_devices`, and the output directory. Leave `media.enabled: false`
   until paths and available hardware have been reviewed with the user.
5. Ask before turning `media.enabled` on. Then have the user reload VS Code and
   run **Forge: Check Media Setup** (`forge.checkMediaSetup`). Fix each required
   missing path it names, then check again. The check reads paths and tool
   versions; it does not launch a render or measure live GPU memory. Render
   startup checks the configured free-VRAM threshold. A missing
   text-to-video still backend or music analyzer is optional when that path is
   not part of the user's chosen workflow.

**Check:** the user confirms the setup report matches the engines and files they
chose. For full setup instructions, see [docs/MEDIA.md](docs/MEDIA.md).

## Finish

Report to the user:

- the config path, the backend, and the active model;
- the Check results, pass or fail, with the output;
- whether the agent note is in `AGENTS.md` and/or `CLAUDE.md` (step 7), and
  that the user's own lines in those files are untouched;
- what you skipped and why;
- anything left for them to do.
