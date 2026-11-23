# Forge setup — instructions for an AI coding agent

You are Claude Code, Codex, or a similar agent. The user installed the **Forge
LLM** VS Code extension and asked you to set it up on this machine. This file
ships inside the extension; the prompt that pointed you here gave you its path
and the two places Forge looks for its config.

Work through the steps in order, run each **Check**, and continue without asking
between steps. Set up an optional section only when the user's setup request
named it or the user picked it in Step 0; offer only the features listed in
Step 0 questions 6-8. The agent mesh is set up when the user picks "Talk to
Forge" there.

## Ground rules

1. **No secrets in files.** API keys, bot tokens and cloud tokens never go in
   `config.yaml`, in git, or in your reply. Forge keeps them in VS Code
   SecretStorage; the user enters them with the Forge command this file names.
2. **One confirmation, then proceed.** After Step 0, show the one-time plan
   summary described there and ask its questions, then wait for the answers.
   They are the one confirmation: after it, do not ask again about anything in
   that summary.
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
   `~/.claude/settings.json` only for the stated mesh setting, VS Code's user
   `settings.json` only for `forge.terminal.watchUserCommands` when the user
   said yes in question 10, and `FORGE.md` only when the workspace has none,
   and the global git `user.name` and
   `user.email` only with the values the user gave in Step 0. Forge writes the
   workspace agent note; leave `AGENTS.md` and `CLAUDE.md` alone and verify the
   marked section. Kill
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
- Every optional feature's engine and files, whatever the request names,
  read-only, in the same folders as the model files:
  - image generation: `sd-server` and the model files Step 10 lists;
  - video and music: a ComfyUI checkout and its Python, the LTX-2.5 and
    ACE-Step 1.5 files Step 11 lists, and `ffmpeg` / `ffprobe`;
  - voice notes: whisper.cpp's `whisper-cli` or `whisper-server`,
    `ggml-*.bin` models, `piper`, and Piper voices (`*.onnx` with their
    `.onnx.json`);
  - codebase index: an embedding GGUF (EmbeddingGemma, nomic-embed, bge and
    the like), which is not a chat model.
  Note free disk space, and which GPU each feature could use.
- Is Ollama running? `curl http://127.0.0.1:11434/api/tags`
- Are `llama-server`, `claude`, `codex` on PATH, and is `pwsh` available if
  Codex is selected on Windows? Is there an existing Forge config at either
  path the prompt gave you?
- Is `FORGE.md` already present at the repository root?
- On Windows, is Git for Windows' `bash.exe` available? If Claude Code is
  installed, is it configured to run in bypass-permissions mode?
- Check whether `git config --global user.name` and
  `git config --global user.email` are set, from their exit status only; never
  print either value.
- Is Tailscale installed? Check only that the `tailscale` command exists
  (`tailscale version`); do not run `tailscale status` and do not contact
  any other machine during the survey.
- Does an existing Forge config list servers under `mcp_servers`? Note each
  server's `name`, whether it has `eager: true`, and whether
  `~/.forge/policy.yaml` exists. Read only; do not start a server.

**Other computer, asked first.** When Tailscale is installed, ask one
question before you choose the backend: "Use models from another of your
computers over Tailscale?" with "Yes, look for them" and "No". Only after a
yes, run `tailscale status` (it reads and changes nothing). For each other
machine it lists, read `GET http://<its Tailscale IP>:8798/models`
(read-only; use the IP, because Forge refuses a host name). Note every model
whose `remote` is `true`, by `name`. A yes here is a yes to "Other computer"
in question 6. After a no, or without Tailscale, do not contact any other
machine.

Then choose the backend from the survey and state why; do not ask the user to
choose the backend. The one thing you ask is which model is the default, in the
Step 0 question:

- **Other computer** — the user said yes to the question above and another
  of their computers serves models: this machine uses them through
  **Forge: Connect to my desktop** (Step 12), so a small GPU here does not
  matter. CLI models are added beside them when `claude` or `codex` is
  installed.
- **llama.cpp** — fastest and the most control; needs a GGUF that fits.
- **Ollama** — simplest if it is already installed and has models.
- **Strata or Maya** — engines for large mixture-of-experts models
  ([Niko1221/Strata](https://github.com/Niko1221/Strata),
  [mw00/project-maya](https://github.com/mw00/project-maya)). Models another
  computer already serves on them need nothing installed here. Installing an
  engine on this machine is the user's choice: question 12 asks it.
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
- that every trust switch starts off in the new config and is turned on only
  when the user picks it in the questions below; `control_server` is always on
  (loopback only, token-protected);
- the exact config file path to write, plus which optional sections were named
  in the user's request; and whether it will create `FORGE.md` because the
  workspace has no project instruction file.
- the default model (`active_model`): your recommendation and up to three
  alternatives, chosen from the models the survey found here and on the other
  computer;
- a **Features** table, one row per feature in questions 7 and 8: what is
  already on disk (paths), what is missing (exact filenames and sizes), and
  "not possible here: <reason>" only when it cannot be installed or run on
  this machine at all (for example, no NVIDIA GPU for video). When it can be
  installed but this machine has less free VRAM than Forge's config starts it
  with, the row reads "can install; may not run here: <free> MB free, Forge's
  config starts it at <min_free_vram_mb> MB", and the feature is still
  offered. A feature's downloads
  and installs are part of the plan, and picking it confirms them. Image
  generation is "not possible here" only when this machine has no suitable
  GPU, no cloud image provider is configured, and "Other computer" is not in
  the plan. With "Other computer", its row reads "through <that computer's
  name>: nothing to download here", and it is offered in question 7.

Write the plan summary in your reply first, and add this line to it: "Reverse
image search uploads your image to litterbox.catbox.moe for one hour, and asks
you every time." Then ask the questions below. Together they are the one
confirmation: after it, do not ask again about a listed download, install,
switch, config path, optional section or extra. If an unlisted dependency
becomes necessary, skip that part and explain why in **Finish** instead of
asking again.

With a multiple-choice question tool (Claude Code: `AskUserQuestion`, at most
four questions per call and four choices per question), ask questions 1-4 in
one call, 5-8 in a second call straight after it, and 9-12 in a third call.
Without such a tool, ask the same questions in one text message, in the same
order and with the same wording. "No, change nothing" means stop without
changing files, installing software, or downloading models. Offer "Run Forge's
messages without asking" only when Claude Code uses bypass-permissions mode.
Ask question 9 only when the survey found `user.name` or `user.email` empty.
Ask question 11 only when the survey found servers under `mcp_servers` and no
`~/.forge/policy.yaml`. In questions 7 and 8, mark a feature (Recommended) when
the survey found all of its files, and leave out a feature the Features table
marks "not possible here".

1. **Plan** (one choice): "Proceed with this setup plan?" with "Yes, proceed"
   and "No, change nothing".
2. **Default model** (one choice): "Which model should Forge use by default?"
   Your recommendation first, marked (Recommended), plus up to three
   alternatives the survey found here or on the other computer; the user can
   type any other listed name. With only one model found, offer "Use <model>"
   and "Pick another (type its name)". A default model from the other computer
   means yes to "Other computer".
3. **Coding agents** (multi-select): "What may Claude Code and Codex do with
   Forge?"
   - **Talk to Forge**: Your coding agents on this PC can message Forge chats and read the replies (local only, password-protected). Forge adds a short section about this to AGENTS.md / CLAUDE.md in every workspace you open, never to a file your git repository commits, and removes it when you turn this off or uninstall Forge. The next two need this one.
   - **Run Forge's messages without asking**: Messages from Forge and other sessions can start work in Claude Code with no approval prompt.
   - **Global note**: Add Forge's note to your global CLAUDE.md / AGENTS.md so your agents can reach Forge from any folder.
   - **Hand tasks over**: Forge's model can start Claude Code or Codex on a task. Uses your subscription.
4. **PC control** (multi-select): "What may Forge control on this PC?"
   - **Browser**: Open pages in a separate Chrome/Edge window and click and type. Asks before each new website.
   - **Desktop**: Take screenshots and use the mouse and keyboard.
   - **Scheduled jobs**: Run tasks on a schedule, including waking the PC.
   - **Jobs may run Claude Code / Codex**: A scheduled job can start your coding agent. Picking this also turns scheduled jobs on.
5. **File actions** (multi-select, both marked (Recommended)): "Which file
   actions may Forge take in your workspace?"
   - **Delete files**: Each delete still shows an approval card.
   - **Git commit**: Each commit still shows an approval card.
6. **Extras** (multi-select): "Set up any of these now?"
   - **Web search**: DuckDuckGo, no key, no account.
   - **Telegram**: chat with Forge from your phone. Needs your own bot from
     @BotFather; pairing code required.
   - **Other computer**: use models from another computer of yours, or share
     this one's (Tailscale).
   - **Daily chat retitle**: rename idle chats each morning to say what they
     were about.
7. **Media** (multi-select): "Set up media generation?"
   - **Image generation**: Make and edit pictures: locally with stable-diffusion.cpp (free, needs a GPU) or with a cloud key (billed per image).
   - **Video**: Short clips with LTX-2.5 through ComfyUI. Needs a large GPU.
   - **Music**: Songs with ACE-Step 1.5 through ComfyUI.
   - **Voice notes**: Talk to Forge on Telegram: voice notes are transcribed on this PC with whisper.cpp, and `/voice` reads replies aloud with Piper. Needs Telegram.
8. **More tools** (multi-select): "Add any of these?"
   - **Codebase index**: Search your code by meaning (`search_codebase`). A small embedding model runs on the CPU.
   - **Reverse image search**: Find where a picture appears online, with Yandex (fast, the default) and Google Lens. One SerpApi key covers both, and SerpApi has a free plan; each search uploads the image to litterbox.catbox.moe for one hour.
   - **Cloud models**: Add OpenRouter or OpenAI models next to the local ones. Needs your key; the provider bills you.
   - **Chats may start chats**: A chat may open a new chat or interrupt a running one (`message_chat` new / steer).
9. **Git name and email** (one choice): "Name and email for your commits?"
   with "Skip" and "Set it now (type `Name <email>` in Other)".
10. **Your terminal** (one choice): "Should Forge's agent see the commands you
    run in your own VS Code terminals, and their output? That text goes to the
    model you chat with, which may be a cloud model." with "No, keep my
    terminal private (Recommended)" and "Yes, let it see them".
11. **MCP tools** (multi-select): "Which MCP servers do you trust to run their
    tools without asking each time?" One choice per server the survey found
    (its `name`), up to four; the user can type more names in Other. Each
    choice's description: "Its tools run without a card, except in a chat
    that has read a secret file." Picking none keeps every MCP tool asking
    before each call.
12. **Model engine** (one choice): "Install a local model engine on this PC?"
    with "No (Recommended)", "llama.cpp", "Strata" and "Maya". Offer
    "llama.cpp" only when the chosen backend is not llama.cpp, described as
    "For small GGUF models on this PC, for example while the other computer is
    off." Strata and Maya run large local models: each one's description names
    its requirement from that engine's README (for example "Needs an NVIDIA
    RTX 30, 40 or 50 GPU") and, when the survey shows this machine falls
    short, adds "This PC has <GPU, free VRAM, RAM>: it may not run here."

Each pick turns on exactly what Step 5 lists for it; a switch the user did not
pick stays off. "Run Forge's messages without asking" and "Global note" need
"Talk to Forge"; "Jobs may run Claude Code / Codex" also turns scheduled jobs
on. "Voice notes" needs Telegram: picking it runs Step 8 too, and the plan
summary says so.

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

**Git identity.** When the user gave a name and email in Step 0, run
`git config --global user.name "<name>"` and
`git config --global user.email "<email>"` with exactly those values. Without
an answer, set nothing and say so in **Finish**. Never invent either value.

## Step 2 — llama.cpp backend (skip for Ollama / cloud)

Run this step too when the user picked "llama.cpp" in Step 0 question 12:
its model sits beside the chosen backend's models, and the chosen default
model stays the default.

If the chosen backend is llama.cpp, or the user picked it in question 12, and
no `llama-server` is on PATH, install
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

Find the newest release with
`GET https://api.github.com/repos/<owner>/<repo>/releases?per_page=10` and
take the newest one that carries the asset you need, not
`/releases/latest`: a project's "latest" release can carry no binaries at
all. This applies to every GitHub download in this file.

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

## Step 4 — Cloud or CLI models (when selected from the survey, or picked as "Cloud models")

- OpenAI-compatible providers (`openrouter`, `openai`,
  `openai-compatible`): start from `config/starter/openai-compatible.yaml`.
  If a key is needed, tell the user to run **Forge: Set Cloud Provider Token**
  (`forge.setCloudToken`) in VS Code, enter it there, and wait. Never request,
  read, or repeat the key. Verify the selected provider with the Step 6 check.

  For a "Cloud models" pick, add them beside the local models rather than
  instead of them: use OpenRouter unless the setup request names OpenAI, and
  add the provider's current general coding model from its official model
  list. The user adds more later.
- Claude Code / Codex as a model: if the selected CLI is missing, install it
  from the vendor's current official instructions after the one plan
  confirmation; include the exact install method and required prerequisites in
  the summary. Never ask the user to install it. On Windows, Codex also needs
  PowerShell 7 from the **MSI**, not the Microsoft Store; install it if missing
  and include it in the summary. Stop for the login only: tell the user to run
  `claude` or `codex login`, wait, then verify the CLI. Add
  `{ name: claude-code, provider: cli, cli: claude }` (same for `codex`) under
  `models:`. `cli` is a bare name, or a full path to the executable. A `.cmd`
  shim is run through its launcher, which needs Node on PATH. Set
  `permissions.agents.delegate: true` only when the user picked "Hand tasks
  over" in Step 0.

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
block. The control server is always on. Then write the Step 0 picks, and only
those:

- "Talk to Forge": `agent_bus.enabled: true`.
- "Run Forge's messages without asking": merge
  `"crossSessionInbound": "accept"` into `~/.claude/settings.json`, preserving
  other settings.
- "Global note": done in Step 7.
- "Hand tasks over": `permissions.agents.delegate: true`.
- "Browser": `permissions.browser.enabled: true`.
- "Desktop": `permissions.desktop.enabled: true`.
- "Scheduled jobs": `jobs.enabled: true`.
- "Jobs may run Claude Code / Codex": `jobs.enabled: true` and
  `jobs.allow_cli_agents: true`.
- "Delete files": `permissions.fs.delete: true`.
- "Git commit": `permissions.git.write: true`.
- "Daily chat retitle" (question 6): `jobs.enabled: true`; Step 13 creates the job.
- "Image generation" (question 7): Step 10. "Video" and "Music": Step 11.
- "Voice notes": Step 8a, after Step 8.
- "Codebase index" (question 8): Step 9a.
- "Reverse image search": Step 9b.
- "Cloud models": Step 4.
- "Chats may start chats": `permissions.chats.new_chat: true` and
  `permissions.chats.steer: true`.
- "llama.cpp" (question 12): Step 2, with a model that fits this PC.
- "Strata" or "Maya" (question 12): Step 12a.
- "Yes, let it see them" (question 10): merge
  `"forge.terminal.watchUserCommands": true` into VS Code's user
  `settings.json` (Windows `%APPDATA%\Code\User\settings.json`, macOS
  `~/Library/Application Support/Code/User/settings.json`, Linux
  `~/.config/Code/User/settings.json`; `Code - Insiders` in place of `Code`
  for VS Code Insiders), keeping its other settings and comments. "No"
  changes nothing: the setting is off by default.
- Each server picked in question 11: Step 7a.

Leave every switch the user did not pick off.

## Step 6 — First reload, then verify

This is the one reload the agent may hand to the user: before this first
reload, Forge's control server and agent bus are not running. Tell the user to
open the Command Palette and run **Developer: Reload Window**, then wait. Do
not ask them to run **Forge: Validate Config**; the control-server checks below
validate the active config.

When the user said yes to "Other computer" in Step 0, run Step 12 now, after
this reload and before the checks below.

Read the control server's discovery record:
`%LOCALAPPDATA%\forge-llm\control-server.json` on Windows,
`~/.forge/control-server.json` where `LOCALAPPDATA` is unset. Take the port
from its `url` field instead of assuming the configured port or asking, and
its `token` field for the `Authorization: Bearer <token>` header that every
check below except `/healthz` needs. The token changes each time Forge
starts, so read the file again after a reload. Never print the token or write
it to a file.

**Check**, from your shell (on Windows PowerShell use `curl.exe`, not `curl`),
with `Authorization: Bearer <token>` on every request but `/healthz`, and
`Content-Type: application/json` on every POST:

```text
GET  http://127.0.0.1:<port>/healthz        → {"ok":true}, no token needed
GET  http://127.0.0.1:<port>/models         → lists the configured models
POST http://127.0.0.1:<port>/ensure  {"model":"<active_model>"}   → 200 once loaded
POST http://127.0.0.1:<port>/chat    {"model":"<active_model>","messages":[{"role":"user","content":"Reply with the word ready."}]}
POST http://127.0.0.1:<port>/release {"model":"<active_model>"}   → after /chat, only when /ensure ran
```

A 401 means the token is missing or stale: read the file again and retry
once. `/ensure` holds the model loaded until `/release` lets it go, so always
send the `/release` after an `/ensure`, also when `/chat` failed.

Run `/ensure` only when `/models` lists the active model with
`"servable": true`. Run `/chat` when the row has `"servable": true`, or
`"route": "chat"` with `"availability": "ready"`: a cloud model or a desktop
model from Step 12 is served elsewhere, so there is nothing here to load and
`/chat` alone is its live test. Skip whichever does not apply and say so: a
`provider: cli` model runs only inside a Forge chat, and Step 7's chat is its
live test.

`/ensure` can take minutes for a large model. The `/chat` request is the first
prompt; do not ask the user to send one. If a backend fails and its details are
only in VS Code's **Forge - llama-server** output channel, tell the user to run
**Forge: Show Backend Console** (`forge.showBackendConsole`) and paste the
error text. If the config is rejected before the control server starts, Forge
shows the validation error in a VS Code notification; there is no control API
or readable log file for that startup error, so ask the user to copy the exact
notification. Do not claim setup passed until the checks succeed.

## Step 7 — Agent mesh (Forge ⇄ Claude Code ⇄ Codex)

Skip this step when the user did not pick "Talk to Forge" in Step 0, and say in **Finish** that `agent_bus: { enabled: true }` turns it on later.

Workspace memories are editable files in `~/.forge/memories/<workspace-folder>-<workspace-id>/`; changes take effect on the next read.

The mesh is how Claude Code, Codex and Copilot message, steer and stop Forge
chats, and is on only when the user picked "Talk to Forge". Forge installs its
message client at `~/.forge/agent-bus/forge.sh` and its own notes in
`~/.forge/agent-bus/README.md`; read that README rather than this section for
the command set.

**Read the state, do not guess it.** From the config you wrote, report
`control_server.enabled` and its port, `agent_bus.enabled`,
`permissions.agents.delegate`, and the path of every agent CLI you found
(`claude`, `codex`, `copilot`). The planned switches have already been
confirmed; turn on only those listed in the plan. The mesh is *inbound* — it
lets other agents act on this workspace's Forge chats. Requirements:

- the control server from step 5, and the bus itself (Step 5 turned it on):

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
- if the user picked "Run Forge's messages without asking", Step 5 added
  `"crossSessionInbound": "accept"` to `~/.claude/settings.json`; without it,
  messages from Forge wait for approval in Claude Code.

Forge writes the agent note itself, so you do not have to. On the first start in
a workspace whose mesh is on, Forge adds one marked section
(`<!-- forge-agent-mesh:start -->` … `<!-- forge-agent-mesh:end -->`) to
`AGENTS.md`, creating it when missing, and to an existing `CLAUDE.md` unless that
file already imports `AGENTS.md` with an `@AGENTS.md` line; a missing `CLAUDE.md`
is created holding only that import line, so Claude Code reads the section once. It never touches text outside the
markers and never adds the section twice. When the mesh is later turned off it
removes only its own section, and deletes a file only when Forge created it and
nothing else is left in it. **Verify it instead of writing it:** read the file, confirm
exactly one marked section is there and that the user's own lines are untouched.
If it is missing after startup, use the running mesh to reload the Forge
window and check again. Say plainly what the section allows: local coding agents can now
message, steer and stop this workspace's Forge chats; `agent_bus:
{ enabled: false }` turns that off; deleting everything between the two comment
lines removes the note.

When the user picked "Global note" in Step 0, tell the user to run **Forge:
Add Agent Note to My User Files** (`forge.agentMesh.installUserNote`) and paste
the message it shows. You do not write those files yourself. **Check:** the
message names `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, each created,
added, replaced or unchanged.

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
report it, and do not explain the bridge to that session: the check is whether
the note works on its own, and explaining it would hide a broken note. After the first reload,
reload any Forge window with
`forge.sh reload <name> --to <conversationId>`; get the id from `who` or the
chat opened by `say --new`.

## Step 7a — Trusted MCP tools

Skip this step when the user picked no server in question 11. Without the
mesh (no "Talk to Forge"), skip it and say in **Finish** how to list the
tools by hand.

For each picked server without `eager: true`, ask a new Forge chat to load
its tools and name them:
`printf 'Run load_tool_group with group "<server name>" and reply with its result only.' | forge.sh say <name> --new`,
then read the answer with `forge.sh view <name> --to <conversationId>`. It
reads `<server name> tools enabled for this conversation: <tool>, <tool>.`
followed by one more sentence. A server with `eager: true` has no group: skip
it and name it in **Finish**.

Write each named tool under that server's `tool_permissions` with the `read`
tier, keeping every entry already there. For example, for a server named
`files` whose answer named `search` and `read_page`:

```yaml
# partial: one mcp_servers entry only, not a whole config
mcp_servers:
  - name: files
    command: C:/tools/files-mcp.exe
    tool_permissions:
      search: read
      read_page: read
```

Then reload the Forge window with `forge.sh reload <name> --to <conversationId>`
so the servers reconnect with the new list. A listed tool runs without a
card; in a chat that has read a secret file, every MCP call still asks the
owner.

**Check:** after the reload, `GET /healthz` from Step 6 answers
`{"ok":true}`.

## Step 8 — Optional: Telegram remote control

Run this section only when the user's setup request names Telegram or the user
said yes to Telegram in Step 0. Do not ask about it again. The bot token,
pairing code, and authenticator QR stay with the user; the agent handles the
config and checks.

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

## Step 8a — Optional: voice notes

Run this section when the user picked "Voice notes" in Step 0 or the setup
request names voice, after Step 8: voice notes arrive over Telegram. Use what
the survey found, and download only what the confirmed plan listed.

1. **Speech to text.** `whisper-cli` from the newest `ggml-org/whisper.cpp`
   release that carries a Windows, macOS or Linux build for this machine
   (Step 2's rule: not `/releases/latest`; a CUDA build on an NVIDIA GPU),
   and one model from the official
   `ggerganov/whisper.cpp` model repository: `ggml-large-v3-turbo.bin` with
   a GPU, `ggml-base.bin` without one.
2. **Spoken replies.** Piper `2023.11.14-2`, the last `rhasspy/piper`
   release with prebuilt binaries. Its release reports no `digest`, so
   check the file against this table instead, and stop that install on any
   difference:

   | File | Bytes | SHA-256 |
   |---|---|---|
   | `piper_windows_amd64.zip` | 22477236 | `f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea` |
   | `piper_linux_x86_64.tar.gz` | 26460462 | `a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992` |
   | `piper_linux_aarch64.tar.gz` | 26004717 | `fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb` |
   | `piper_macos_x64.tar.gz` | 19146927 | `ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b` |
   | `piper_macos_aarch64.tar.gz` | 19146957 | `6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc` |

   Voices come from the official `rhasspy/piper-voices` repository: each
   voice's `.onnx` file and its `.onnx.json`, all in one folder. Forge has
   two voice slots, and setup fills both: `voice_en` with
   `en_US-amy-medium`, and `voice_el` with the Greek
   `el_GR-rapunzelina-low`. The plan summary lists both voices with their
   sizes.
3. Add, with absolute paths:

   ```yaml
   # partial: the voice block only, not a whole config
   voice:
     enabled: true
     whisper_binary: <whisper-cli path>
     whisper_model: <ggml .bin path>
     compute:
       gpu: true          # false without an NVIDIA GPU
     output:
       piper_binary: <piper path>
       voices_dir: <folder holding the voice files>
       voice_en: en_US-amy-medium   # the voice file's name without .onnx
       voice_el: el_GR-rapunzelina-low
   ```

   Leave `voice.output.enabled` off: the user turns spoken replies on with
   `/voice on` in Telegram. With more than one GPU, set `compute.device` to
   the one with the most free VRAM (whisper.cpp's CUDA ordinal).

**Check:** `whisper-cli --help` and `piper --help` print their usage, and
after the reload the config loads with no `voice.` error. A real voice note
can be tested only after Telegram is paired; say so in **Finish**.

## Step 9 — Optional: web search

Run this section only when the user's setup request names web search or the
user said yes to "Web search" in Step 0. Add this block to the config and set
`permissions.net.search: true`; DuckDuckGo needs no key and no account:

```yaml
# partial: the search block only, not a whole config
search:
  provider: duckduckgo
  max_results: 20
```

Add Tavily only when the user asks for it. If a Tavily key is not already
stored, tell the user to run **Forge: Set Search API Key**
(`forge.setSearchApiKey`) in VS Code, enter the key there, and wait; then add
`fallback: tavily` to the block. Never request, read, or repeat the key.

`search` and `permissions` are policy keys. Before Step 14 they go in the config,
and the move carries them over. When `~/.forge/policy.yaml` already exists (a
later run of this step), Forge refuses to load a config that holds them, and
that file is the user's to edit: show the user the block and the
`net: { search: true, … }` line to add to `policy.yaml` themselves, then have
them run **Developer: Reload Window**.

## Step 9a — Optional: codebase index

Run this section when the user picked "Codebase index" in Step 0 or the setup
request names it. It needs `llama_server.binary`: on a machine that uses
another computer's models and has no llama.cpp yet, install the CPU build
the way Step 2 does, and list it in the plan. Use an embedding GGUF the
survey found, or download an EmbeddingGemma 300M GGUF (Q8_0 or Q4_0) from an
official repository, with its exact filename and size in the plan. Add:

```yaml
# partial: the embeddings block only, not a whole config
embeddings:
  enabled: true
  model_path: <embedding GGUF path>
  device: none          # CPU, which keeps GPU memory free
  prompt_style: gemma   # EmbeddingGemma only; none for nomic-embed, bge and others
```

**Check:** after the reload the config loads with no `embeddings.` error.
Forge builds the index on the first `search_codebase` call and asks before
starting the embedding server; tell the user to allow it.

## Step 9b — Optional: reverse image search

Run this section when the user picked "Reverse image search" in Step 0 or the
setup request names it. Tell the user to get a key at serpapi.com, then run
**Forge: Set Cloud Provider Token** (`forge.setCloudToken`) in VS Code with
the key name `serpapi` and enter the key there. Wait; never request, read or
repeat it. SerpApi's free plan is enough to start, and the one key serves
both engines the tool offers: Yandex (the default) and Google Lens. Add:

```yaml
# partial: the image_search block only, not a whole config
image_search:
  provider: serpapi_lens
  secret_key_name: serpapi
```

**Check:** after the reload the config loads with no `image_search.` error.

## Step 10 — Optional: image generation

Run this section when the user picked "Image generation" in Step 0 question 7,
or the setup request names it. Do not ask which route to use: choose the local
backend when the surveyed hardware has a suitable unused GPU; otherwise use an
already configured cloud provider.
With "Other computer" in the plan and neither of those routes here, the
other computer renders the images: write no `image_generation:` block.
Step 12's **Connect to my desktop** turns this on, and its message then
says "turned on remote_media, so this laptop asks the desktop to render
images". When it does not say so, the other computer does not share media
yet; say in **Finish** that its owner turns on `cloud_relay.media` there.
If no route is available, skip it and state the missing requirement in
**Finish**. `generate_image` appears only when an `image_generation:` block
exists, and it needs `permissions.net.fetch: true` (a local backend is fetched
over localhost too). Include all model and server downloads and sizes in the
one plan summary.

**Cloud (billed per image).** Any provider serving the OpenAI images endpoint
(`openai`, or `openai-compatible` with an `endpoint`). If the key is not
already stored, tell the user to run **Forge: Set Cloud Provider Token**
(`forge.setCloudToken`) in VS Code and enter it there. Wait, then add a backend
with `provider`, `model` and `api_key_secret` to the `image_generation:` block.
Every call asks for approval.

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

Run this section when the user picked "Video" or "Music" in Step 0 question 7,
or the setup request names them. It is off by default; configure only the
picked or named engines and include every required download and exact size in
the single plan summary.

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
   - Each free-VRAM figure above is the `min_free_vram_mb` startup check in
     Forge's config, not the engine's own minimum. Forge already runs
     ACE-Step with its CPU offload on (`offload_to_cpu`), so music can work
     on a smaller card, slowly: say that instead of "not possible". LTX-2.5
     video below 11 GB free is not expected to run. Lower
     `min_free_vram_mb` only when the user picked the feature after a "may
     not run here" row, and tell them the value you wrote.
   - Video and music run on this machine only: "Other computer" serves chat
     models and images, not video or music.
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
   The user picked or named the media section; the one plan confirmation
   authorizes the listed downloads. Download only files needed for the picked
   or named engine; use LTX-2.5 for video by default and ACE-Step 1.5 for
   music unless the user's request names a different engine.
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

## Step 12 — Optional: models from another computer (Tailscale)

Run this section only when the user's setup request names it or the user said
yes to "Other computer" in Step 0. These are instructions for the user: the
user's Tailscale network is theirs to change. You may run only
`tailscale status`, which reads and changes nothing. Never run `tailscale up`,
`login`, `serve` or `set`, and never edit the access rules yourself.

Run it right after Step 6's reload and before Step 6's checks: Forge registers
**Connect to my desktop** only once it has loaded a config, and its models must
be in the config when Step 6 checks it.

When Step 0 already read the other computer's list after the user's yes, skip
items 1-3: that computer is shared and its access rule already lets this one
in.

1. Tell the user to install Tailscale on both computers and sign in to the same
   account. Wait, then run `tailscale status` and report both machines' names.
2. On the computer that has the models (the main computer), tell the user to
   run **Forge: Share this computer** (`forge.shareComputer`). Its message names
   the ports it shares (by default 8798 for the model starter and 8797 for the
   cloud relay).
3. Tell the user to open the Tailscale admin page, **Access controls**, and add
   this rule with their own names filled in:
   `{"action": "accept", "src": ["<this computer or your user>"], "dst": ["<main computer>:8797,8798"]}`
4. On this computer, tell the user to run **Forge: Connect to my desktop**
   (`forge.connectDesktop`), then **Forge: Check connection**
   (`forge.checkConnection`), and paste its result to you.
5. When the user chose a model from the other computer as the default, set
   `active_model` to its name exactly as `GET /models` listed it, after
   Connect's message says it was added. Until then write `active_model: null`
   (never `""`, which fails validation and leaves Forge in setup mode, where
   **Connect to my desktop** does not exist).

**Check:** read the pasted result. Every link it lists passes, or name the
first broken link and the step above that fixes it.

## Step 12a — Optional: Strata or Maya engine

Run this section only when the user picked "Strata" or "Maya" in Step 0
question 12. Models another computer serves on these engines never need it.
Do items 1-2 before Step 6, and write the model in the same config write as
the rest, so Step 6's reload loads it.

1. Read the engine's README in its official repository
   ([Niko1221/Strata](https://github.com/Niko1221/Strata),
   [mw00/project-maya](https://github.com/mw00/project-maya)) and install it
   the way that README says, from its official release or setup script. Do
   not build from source when the README offers an installer.
2. Download only the model files the README names for a model that fits the
   survey (Step 0's fit rule applies); their exact filenames and sizes are in
   the plan summary.
3. Start the engine the way its README says and note the local address it
   serves. Add one model to `config.yaml` against that address, following the
   commented Strata example in `config/config.example.yaml`
   (`provider: openai-compatible`, `endpoint`, `model`, `num_ctx`). Forge
   does not start this engine: tell the user to start it before using the
   model. Forge can start and stop it through an `engines:` entry
   (`start_command` / `stop_command`, see `config/config.example.yaml`); that
   is the user's edit, and once Step 14 has run it lives in
   `~/.forge/policy.yaml`, which you never write.

**Check:** the engine's `GET /v1/models` lists the model, and a one-line chat
with the new model in Forge answers.

## Step 13 — Optional: daily chat retitle

Run this section only when the user said yes to "Daily chat retitle" in Step 0,
after Step 6's checks passed (and Step 7's, when it ran). A `provider: cli` model in a Forge chat has no
`manage_jobs`, so open a new chat on a model that is not `provider: cli` with
`forge.sh say <name> --new --model <that model>` and the message on stdin.
When the user did not pick "Talk to Forge", `forge.sh` cannot reach Forge:
give the user the message below to paste into a new Forge chat on such a
model, and ask them for the job name and id it reports.
When every configured model is `provider: cli`, skip this step and say so in
**Finish**.

    Create this job with manage_jobs: {"name":"Daily chat retitle","enabled":true,"wake":false,"after":"stay_awake","schedule":{"kind":"daily","at":"06:00"},"check":{"kind":"none"},"on_change":{"kind":"notify"},"action":{"kind":"retitle","max_chats":20,"min_idle_minutes":60,"dry_run":false,"report":"always"}}

**Check:** read the answer with
`forge.sh view <name> --to <the new chat's conversationId>`; it names the
created job and its id. Without the mesh, the user reports them.

## Step 14 — Move the security settings into policy.yaml

Run this last: once `~/.forge/policy.yaml` exists, Forge refuses a
`config.yaml` that still holds a security key, so every config edit above must
already be done. You never write `policy.yaml`; the user runs Forge's own
command for it.

Tell the user to run **Forge: Move security settings to policy.yaml**
(`forge.movePolicy`) and paste the message it shows. Do not edit `config.yaml`
again after this step.

**Check:** repeat `GET /healthz` from Step 6 (it answers `{"ok":true}`), and
confirm `config.yaml` no longer holds any of the keys the pasted message says it
moved.

## Finish

Report to the user:

- the config path, the backend, and the active model;
- the Check results, pass or fail, with the output;
- whether the agent note is in `AGENTS.md` and/or `CLAUDE.md` (step 7), and
  that the user's own lines in those files are untouched;
- whether the git identity was set (Step 1), and if not, that no name or email
  was given;
- one line per optional section not set up, each with why it was skipped and
  how to add it later:
  - Telegram — not requested or declined; name it to follow Step 8 and enter a bot token.
  - Web search — not requested or declined; name it to follow Step 9 (DuckDuckGo, no key).
  - Image generation — not picked or named; pick it next time, or name it to follow Step 10.
  - Video or music — not picked or named; pick it next time, or name it to follow Step 11.
  - Voice notes — not picked or named; name it to follow Step 8a.
  - Codebase index — not picked or named; name it to follow Step 9a.
  - Reverse image search — not picked or named; name it to follow Step 9b.
  - Cloud models — not picked or named; name it to follow Step 4.
  - Other computer — not requested or declined; name it to follow Step 12.
  - llama.cpp on this PC — not picked in question 12; name it to follow Step 2.
  - Strata or Maya — not picked in question 12; name it to follow Step 12a.
  - Daily chat retitle — not requested or declined; name it to follow Step 13.
  - Global note — not picked in Step 0; name it to follow Step 7.
  - Terminal capture — not picked in question 10; set `forge.terminal.watchUserCommands` to `true` in VS Code's settings to turn it on.
  - MCP tools — a server not picked in question 11, an `eager: true` server, or every server when the mesh is off: its unlisted tools ask before each call; list a tool under that server's `tool_permissions` (for example `search: read`) in `config.yaml`, or in `~/.forge/policy.yaml` once Step 14 has run, to let it run without asking.
- any requested section skipped because a prerequisite was missing;
- each remaining human action and why: plan confirmation, required login or
  secret entry (including Telegram authentication), Windows prompt, first
  reload, or a VS Code-only startup error;
- these owner-only choices, unchanged: `~/.forge/policy.yaml`, **Always in this
  project**, and Clanker for ordinary chats.

Then tell the user where things live: Forge ships five skills inside the
extension (blender, hf-download, music-track, office-files, video-clip), updated with
Forge; their own skills go in `~/.forge/skills/<name>/`. Memories start empty
and fill as agents save them. `FORGE.md` is theirs to edit.
`docs/CODING_TIPS.md` appears when an agent records its first lesson. The
browser tool and desktop control are on only if the user picked them in
Step 0 (each new website is approved once per session, and VS Code's own window
stays off limits); `permissions.browser.enabled` and
`permissions.desktop.enabled` change either.
