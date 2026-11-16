# Forge setup — instructions for an AI coding agent

You are Claude Code, Codex, or a similar agent. The user installed the **Forge
LLM** VS Code extension and asked you to set it up on this machine. This file
ships inside the extension; the prompt that pointed you here gave you its path
and the two places Forge looks for its config.

Work through the steps in order, run each **Check**, and continue without asking
between steps. Set up an optional section only when the user's setup request
named it; never ask which sections to add. The agent mesh is part of the core
setup.

## Ground rules

1. **No secrets in files.** API keys, bot tokens and cloud tokens never go in
   `config.yaml`, in git, or in your reply. Forge keeps them in VS Code
   SecretStorage; the user enters them with the Forge command this file names.
2. **One confirmation, then proceed.** After Step 0, show the one-time plan
   summary described there and wait for one yes/no answer. After yes, do not ask
   again about anything in that summary.
3. **Human-only stops:** required logins (`claude`, `codex login`,
   `ollama auth login`); API keys and bot tokens entered through Forge's own
   commands; Windows UAC or SmartScreen prompts; and the first VS Code window
   reload before Forge's control server starts. Give the exact command or click,
   wait, then check the result. For requested Telegram setup, BotFather bot
   creation, sending the pairing code, and scanning/confirming the authenticator
   are part of this authentication stop. Never claim the user did it before
   they do.
4. **Owner-only security choices.** Never edit or propose edits to
   `~/.forge/policy.yaml`, never use **Always in this project**, and never turn
   Clanker on for ordinary chats. Name all three in the final report.
5. **Back up before you replace.** If a `config.yaml` already exists, copy it
   to `config.yaml.bak` first, and keep its comments when editing — users
   record VRAM measurements in them.
6. **Stay in scope.** Write the Forge config, the llama.cpp install folder,
   `~/.claude/settings.json` only for the stated mesh setting, and `FORGE.md`
   only when the workspace has none. Forge writes the workspace agent note;
   leave `AGENTS.md` and `CLAUDE.md` alone and verify the marked section. Kill
   no process you did not start.
7. **Trust Forge, not yourself.** A step is done when its Check passes, not
   when the file looks right.

Where the extension is installed, `config/config.example.yaml` is the full,
commented reference for every config key, and `config/starter/*.yaml` are
minimal starting points. Read them instead of guessing a key.

## Step 0 — Survey the machine

Collect and show the user in a short table:

- OS and shell. **On Windows, bare `bash` may be WSL, not Git Bash.** Use
  PowerShell, or Git Bash by full path (`C:\Program Files\Git\bin\bash.exe`).
- GPUs and **free** VRAM: `nvidia-smi --query-gpu=index,name,memory.total,memory.used --format=csv`
  (NVIDIA), `system_profiler SPDisplaysDataType` (macOS), or none.
- System RAM.
- Model files already on disk: search likely folders (Downloads, `~/models`,
  `~/.cache/huggingface/hub`, `~/.cache/lm-studio`, other drives) for `*.gguf`,
  excluding `mmproj-*` projector files. Note size and quantization from the
  filename.
- If the request names image, video, or music generation, inventory those
  engines' model and companion files, disk space, runtimes, and GPU needs too.
  Include the exact sizes of any missing files in the plan summary.
- Is Ollama running? `curl http://127.0.0.1:11434/api/tags`
- Are `llama-server`, `claude`, `codex` on PATH, and is `pwsh` available if
  Codex is selected on Windows? Is there an existing Forge config at either
  path the prompt gave you?
- Is `FORGE.md` already present at the repository root?
- On Windows, is Git for Windows' `bash.exe` available? If Claude Code is
  installed, is it configured to run in bypass-permissions mode?

Then choose **one** backend from the survey and state why. Apply that choice;
do not ask the user to choose:

- **llama.cpp** — fastest and the most control; needs a GGUF that fits.
- **Ollama** — simplest if it is already installed and has models.
- **Cloud / CLI only** — no suitable GPU: an OpenAI-compatible provider, or
  Claude Code / Codex as the model (`provider: cli`).

A model fits when its GGUF size plus the KV cache for the context fits in free
VRAM with **at least 1 GB spare**. On Windows a GPU that runs out does not
fail; it pages to system RAM and slows to a crawl.

Use a suitable model already on disk or in the existing config when possible.
Otherwise choose a general-purpose instruction model that fits the surveyed
hardware; include any required projector or companion files. Before presenting
the plan, get each download's exact filename and size from its official release
or model repository metadata. For Ollama, include the exact tag and reported
download size. Do not start a download before the confirmation.

After the survey and backend choice, show one concise summary containing:

- every model file and release archive to download, with its exact filename
  and size;
- every install, including the selected llama.cpp build, any missing selected
  CLI and its prerequisites, and on Windows only when Git Bash is missing,
  `winget install --id Git.Git -e`; include the exact install method and
  release details;
- each trust switch already on and each one to turn on:
  `control_server`, `agent_bus`, `permissions.agents.delegate`, and
  `crossSessionInbound` in `~/.claude/settings.json` when Claude Code uses
  bypass-permissions mode;
- the exact config file path to write, plus which optional sections were named
  in the user's request; and whether it will create `FORGE.md` because the
  workspace has no project instruction file.

Ask **“Proceed with this setup plan? (yes/no)”** and wait. A no means stop
without changing files, installing software, or downloading models. After yes,
do not ask again about a listed download, install, switch, config path, or
optional section. If an unlisted dependency becomes necessary, skip that part
and explain why in **Finish** instead of asking for another plan confirmation.

## Step 1 — Choose the config location

- **Workspace**: `<workspace>/.forge/config.yaml` — for this project only.
- **Global**: the global path from the prompt — for every workspace.

Use an existing workspace config if it is already the active config. Otherwise
use the global path unless the user's request explicitly asks for a
per-project config. A workspace config wins over the global one when both
exist. Do not ask which location to use; include the selected path in the plan
summary.

If a repository root is open and it has no `FORGE.md`, copy
`<extension>/resources/instructions/FORGE.starter.md` to `FORGE.md` in that
root. Fill **Project facts** and **Commands** from that repository's README,
build and test files; leave every other starter section unchanged. Existing
`FORGE.md` files are left untouched. If no repository root is open, skip this
and explain why in **Finish**.

## Step 2 — llama.cpp backend (skip for Ollama / cloud)

If the chosen backend is llama.cpp and no `llama-server` is on PATH, install
the build selected for this machine and listed in the plan summary:

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

Check each downloaded archive's size and SHA-256 against the official release
metadata before extracting it. Stop that install if a digest is missing or
different. **Check:** `llama-server --version` prints the selected build.

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

## Step 3 — Ollama backend (skip unless selected)

Start from `config/starter/ollama.yaml`. Use tags exactly as `ollama list`
prints them, set `endpoint: http://127.0.0.1:11434`, and choose a `num_ctx` the
model supports. If the selected tag is missing, include its exact size in the
plan, then run `ollama pull <tag>` after confirmation. For Ollama cloud, stop
for the user's `ollama auth login`, then verify the tag through the local
daemon; Forge sends no key.

## Step 4 — Cloud or CLI models (when selected from the survey)

- OpenAI-compatible providers (`xai`, `openrouter`, `openai`,
  `openai-compatible`): start from `config/starter/openai-compatible.yaml`.
  If a key is needed, tell the user to run **Forge: Set Cloud Provider Token**
  (`forge.setCloudToken`) in VS Code, enter it there, and wait. Never request,
  read, or repeat the key. Verify the selected provider with the Step 6 check.
- Claude Code / Codex as a model: if the selected CLI is missing, install it
  from the vendor's current official instructions after the one plan
  confirmation; include the exact install method and required prerequisites in
  the summary. Never ask the user to install it. On Windows, Codex also needs
  PowerShell 7 from the **MSI**, not the Microsoft Store; install it if missing
  and include it in the summary. Stop for the login only: tell the user to run
  `claude` or `codex login`, wait, then verify the CLI. Add
  `{ name: claude-code, provider: cli, cli: claude }` (same for `codex`) under
  `models:`. `cli` is a bare name, or a full path to the executable. A `.cmd`
  shim is run through its launcher, which needs Node on PATH. For delegation
  from Forge also set `permissions.agents.delegate: true` when the mesh is
  enabled.

## Step 5 — Configure the control server and agent mesh

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

Use the configured port, or keep the starter's loopback default when adding the
block. Also ensure `agent_bus.enabled: true`. Set
`permissions.agents.delegate: true` when a supported CLI agent is available.
If Claude Code uses bypass-permissions mode, merge
`"crossSessionInbound": "accept"` into `~/.claude/settings.json`, preserving
other settings. These switches were listed in the one plan confirmation.

## Step 6 — First reload, then verify

This is the one reload the agent may hand to the user: before this first
reload, Forge's control server and agent bus are not running. Tell the user to
open the Command Palette and run **Developer: Reload Window**, then wait. Do
not ask them to run **Forge: Validate Config**; the control-server checks below
validate the active config.

On Windows, read `%LOCALAPPDATA%\forge-llm\control-server.json`. Its
`ControlServerRecord.url` field contains the selected loopback URL; parse its
port from that URL instead of assuming the configured port or asking. If
`LOCALAPPDATA` is unset, the registry path is `null` and no cross-platform
record is available: say so and ask which port Forge selected.

**Check**, from your shell (on Windows PowerShell use `curl.exe`, not `curl`):
use the port parsed from `ControlServerRecord.url`:

```text
GET  http://127.0.0.1:<control_server.port>/healthz        → {"ok":true}
GET  http://127.0.0.1:<control_server.port>/models         → lists the configured models
POST http://127.0.0.1:<control_server.port>/ensure  {"model":"<active_model>"}   → 200 once loaded
POST http://127.0.0.1:<control_server.port>/chat    {"model":"<active_model>","messages":[{"role":"user","content":"Reply with the word ready."}]}
```

`/ensure` can take minutes for a large model. The `/chat` request is the first
prompt; do not ask the user to send one. If a backend fails and its details are
only in VS Code's **Forge - llama-server** output channel, tell the user to run
**Forge: Show Backend Console** (`forge.showBackendConsole`) and paste the
error text. If the config is rejected before the control server starts, Forge
shows the validation error in a VS Code notification; there is no control API
or readable log file for that startup error, so ask the user to copy the exact
notification. Do not claim setup passed until the checks succeed.

## Step 7 — Agent mesh (Forge ⇄ Claude Code ⇄ Codex): core, not optional

Workspace memories are editable files in `~/.forge/memories/<workspace-folder>-<workspace-id>/`; changes take effect on the next read.

The mesh is how Claude Code, Codex and Copilot message, steer and stop Forge
chats, and every new starter config ships it on. Do not skip this step the way
you may skip something the user did not ask for. Forge installs its message
client at `~/.forge/agent-bus/forge.sh` and its own notes in
`~/.forge/agent-bus/README.md`; read that README rather than this section for
the command set.

**Read the state, do not guess it.** From the config you wrote, report
`control_server.enabled` and its port, `agent_bus.enabled`,
`permissions.agents.delegate`, and the path of every agent CLI you found
(`claude`, `codex`, `copilot`). The planned switches have already been
confirmed; turn on only those listed in the plan. The mesh is *inbound* — it
lets other agents act on this workspace's Forge chats. Requirements:

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
  `Get-Command git.exe` finds nothing, say so plainly — the plan included
  `winget install --id Git.Git -e` when available. After the confirmation,
  install it without asking again; stop only for any Windows prompt. If winget
  is unavailable, skip the mesh client and report why. Never fall back to bare `bash`: on
  Windows it may be WSL, and WSL's `$HOME` is not the Windows profile that
  holds `~/.forge/agent-bus`, so the client is not where that shell looks;
- if the user runs Claude Code in bypass-permissions mode, add
  `"crossSessionInbound": "accept"` to `~/.claude/settings.json`, or messages
  from Forge wait for approval there. This was included in the plan summary.

Forge writes the agent note itself, so you do not have to. On the first start in
a workspace whose mesh is on, Forge adds one marked section
(`<!-- forge-agent-mesh:start -->` … `<!-- forge-agent-mesh:end -->`) to
`AGENTS.md` and `CLAUDE.md` — to every one of those two files that exists, or
creates `AGENTS.md` when neither does. It never touches text outside the
markers, never adds the section twice, and never deletes anything when the mesh
is later turned off. **Verify it instead of writing it:** read the file, confirm
exactly one marked section is there and that the user's own lines are untouched.
If it is missing after startup, use the running mesh to reload the Forge
window and check again. Say plainly what the section allows: local coding agents can now
message, steer and stop this workspace's Forge chats; `agent_bus:
{ enabled: false }` turns that off; deleting everything between the two comment
lines removes the note.

Approval rules stay owner-controlled. Do not edit `~/.forge/policy.yaml`, do
not use **Always in this project**, and do not enable Clanker for ordinary
chats; name these pending owner choices in **Finish**. The owner can click **Allow for this chat**
on a card to remember its displayed action in that conversation; `/approvals`
lists the chat and matching project rules, and `/approvals reset` clears only
that chat's remembered rules. **Always in this project** is an owner button that
writes `approvals.always` through Forge; no agent tool can write
`~/.forge/policy.yaml`. If that file is locked, the rule remains chat-only. Scheduled
jobs have no card and use only their owner policy allow list; an unmatched refusal names the exact line to add, so do not retry it.
The owner may set `permissions.approval_timeout_minutes`: a new install ships 10
minutes, and a config with no key still waits forever.

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
leave those files alone apart from Forge's marked agent note.

**Check:** `forge.sh who` reports the linked agent sessions held by open Forge
windows. An empty list is normal before any session is linked. Then run the
end-to-end check yourself: send a prompt on stdin with
`printf 'Reply with the word ready.' | forge.sh say <name> --new`, capture the
chat id from the command result or `forge.sh who`, and read the finished answer
with `forge.sh view <name> --to <conversationId>`. A session that cannot find
the bridge from the file Forge wrote means the note is not doing its job —
report it without explaining the bridge to that session. After the first reload,
reload any Forge window with
`forge.sh reload <name> --to <conversationId>`; get the id from `who` or the
chat opened by `say --new`.

## Step 8 — Optional: Telegram remote control

Run this section only when the user's setup request names Telegram. Do not ask
whether to add it. The bot token, pairing code, and authenticator QR stay with
the user; the agent handles the config and checks.

1. If the user has no bot token, tell them to open **@BotFather**, send
   `/newbot`, and keep the token private. Then tell them to run **Forge: Set
   Telegram Bot Token** (`forge.remote.setTelegramToken`) in VS Code and enter
   the token there. Wait, then continue without reading or repeating it.
2. Set, keeping any existing `remote:` settings:

   ```yaml
   # partial: the remote block only, not a whole config
   remote:
     enabled: true
     telegram:
       enabled: true
   ```

3. Tell the user to run **Forge: Pair Telegram Remote**
   (`forge.remote.pairTelegram`) and send the displayed `/pair ...` code to the
   bot in a private chat. Wait, then continue.
4. Tell the user to run **Forge: Set Up Telegram Authenticator**
   (`forge.remote.setupTelegramTotp`) and scan its QR code with an
   authenticator app. Wait, then continue.

**Check:** continue after the user reports the bot's pairing response and Forge
confirms that the authenticator enrollment succeeded. These results are part
of the Telegram authentication stop; do not ask for another command.

## Step 9 — Optional: web search

Run this section only when the user's setup request names web search. If a
Tavily key is not already stored, tell the user to run **Forge: Set Search API
Key** (`forge.setSearchApiKey`) in VS Code, enter the key there, and wait. Then
add the `search:` block (see `config.example.yaml`) and set
`permissions.net.search: true`. Never request, read, or repeat the key.

## Step 10 — Optional: image generation

Run this section only when the user's setup request names image generation. Do
not ask which route to use: choose the local backend when the surveyed hardware
has a suitable unused GPU; otherwise use an already configured cloud provider.
If neither route is available, skip it and state the missing requirement in
**Finish**. `generate_image` appears only when an `image_generation:` block
exists, and it needs `permissions.net.fetch: true` (a local backend is fetched
over localhost too). Include all model and server downloads and sizes in the
one plan summary.

**Cloud (xAI Grok Imagine, billed per image).** If the key is not already
stored, tell the user to run **Forge: Set Cloud Provider Token**
(`forge.setCloudToken`) in VS Code and enter it there. Wait, then copy the
`image_generation:` block with the `grok-imagine` backend from
`config.example.yaml`. Every call asks for approval.

**Local (stable-diffusion.cpp + Qwen-Image-2.1 Turbo, free per image).** Forge
does not ship the image server or the models; it starts `sd-server` when the
first image is asked for and stops it after `idle_timeout_ms`. It needs **one
NVIDIA GPU with about 12 GB that the chat model is not using**. If the surveyed
card does not meet that requirement, choose the configured cloud route or skip
image setup and explain why.

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
     value about 300 MB lower.
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
   - `confirm_on_start: false` because the one plan confirmation approved this
     local backend; `confirm_each: false` because local images cost nothing.

**Check:** verify the config with Step 6. Confirm that the selected server
binary and every configured model file exist. Do not trigger a billed image
request as a setup check. If the server fails to start and its details are only
in VS Code's **Forge - image server** output channel, tell the user to run
**Forge: Show Backend Console** (`forge.showBackendConsole`) and paste the
error text.

## Step 11 — Optional: local video and music generation

Run this section only when the user's setup request names video or music
generation. Do not ask whether to add it. It is off by default; configure only
the named engines and include every required download and exact size in the
single plan summary.

When requested:

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
   Check each model's license and required files before the plan confirmation.
   The user's request names the media section; the one plan confirmation
   authorizes the listed downloads. Download only files needed for the named
   engine; use LTX-2.5 for video by default and ACE-Step 1.5 for music unless
   the user's request names a different engine.
4. Back up the existing config, then fill only the needed `media:` engine
   entries in `config.yaml`. Set the ComfyUI root, interpreter, model paths,
   `cuda_devices`, and the output directory. Enable only the requested engines
   after checking that their paths and hardware fit the survey. Do not turn on
   unnamed engines.
5. Check that required paths and tools exist and report each result. This check
   reads paths and tool versions; it does not launch a render or measure live
   GPU memory. Render startup checks the configured free-VRAM threshold. A
   missing text-to-video still backend or music analyzer is optional when that
   path is not part of the user's chosen workflow.

**Check:** confirm the setup report matches the requested engines and files.
For full setup instructions, see [docs/MEDIA.md](docs/MEDIA.md).

## Finish

Report to the user:

- the config path, the backend, and the active model;
- the Check results, pass or fail, with the output;
- whether the agent note is in `AGENTS.md` and/or `CLAUDE.md` (step 7), and
  that the user's own lines in those files are untouched;
- one line per unrequested optional section, each with why it was skipped and
  how to add it later:
  - Telegram — not requested; name it to follow Step 8 and enter a bot token.
  - Web search — not requested; name it to follow Step 9 and enter a Tavily key.
  - Image generation — not requested; name it to follow Step 10.
  - Video or music — not requested; name it to follow Step 11.
- any requested section skipped because a prerequisite was missing;
- each remaining human action and why: plan confirmation, required login or
  secret entry (including Telegram authentication), Windows prompt, first
  reload, the port question when `LOCALAPPDATA` is unset, or a VS Code-only
  startup error;
- these owner-only choices, unchanged: `~/.forge/policy.yaml`, **Always in this
  project**, and Clanker for ordinary chats.
