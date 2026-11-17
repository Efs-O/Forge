# Updating llama.cpp

Two ways to move Forge onto a newer llama.cpp build. The **automatic** one is the
`llama-updates` job, which runs the built-in updater and needs nobody. The
**manual** procedure is below it: use it when the job has failed, when you want a
specific older build, or when an owner asks for a hand-run install.

## 1. Automatic — the `llama-updates` job

The job is the normal path. Its definition (`~/.forge/jobs/llama-updates.json`):

```yaml
schedule: daily at 06:15        # wake: yes, stay_awake
check:    github_release ggml-org/llama.cpp, channel: prerelease
action:   llamacpp_update, mode: apply
          asset_pattern: llama-*-bin-win-cuda-*-x64.zip
```

`channel: prerelease` is required: `/releases/latest` returns the `vX.Y.Z` stub,
which carries no builds. A `llamacpp_update` job watching `latest` never sees a
nightly.

### What each stage does (`src/jobs/actions/llamacppUpdate.ts`)

1. The check reports a new `bNNNNN` tag and its asset digests.
2. Download the main zip matching `asset_pattern` (highest CUDA version wins,
   never `arm64`) plus the matching `cudart-llama-bin-win-cuda-<ver>-x64.zip`.
3. Verify each file against the digest the release API publishes. No digest, or a
   mismatch, stops before anything is written.
4. Extract both into `%LOCALAPPDATA%\Forge\llama.cpp-<tag>\`. If that folder
   already exists, stop.
5. Smoke test: `--version` must report the tag, `--list-devices` must list at
   least one CUDA device, and when embeddings are configured one embedding
   request runs on a free port.
6. `apply` requests the switch immediately. `prepare` stops here and waits for
   `/job <n> approve`; that approval expires after 24 h.
7. Switch: write **only** `llama_server.binary`, comments and key order preserved.
   The write is routed by `forgeFileForKey` (`src/config/ConfigWriter.ts`), so it
   lands in `~/.forge/policy.yaml` once that file exists. The backend restarts
   only when no turn is streaming; otherwise the switch waits for the next idle
   tick.
8. Post-check: the restart itself is the check — a healthy server means the new
   binary serves. On failure the config goes back to the binary it held **at that
   moment** (not the one snapshotted at stage 6) and restarts again. A failed
   switch never prunes.

After a successful switch the older build folders are deleted, keeping the new
build, the one it replaced (the rollback), and any build a model pins with its own
`llama_server_binary`. Each release is ~700 MB, so without this they pile up.

### Reading it afterwards

- `manage_jobs get llama-updates` — status, last run, consecutive failures.
- `~/.forge/jobs/runs/llama-updates.jsonl` — one line per run; a switch is
  reported separately from the stage that preceded it.
- `~/.forge/jobs/staged/llama-updates.json` — the staged build while a switch is
  pending. Deleting the job deletes this too, so a staged build cannot survive the
  command meant to stop it.

`manage_jobs run_now` triggers a run on the next scheduler tick, in whichever
window holds the jobs lease.

### Two things that stop a switch

- **The owner lock.** The write goes to the policy file, which the owner can lock.
  A locked file refuses it and names the unlock command; nothing is half-written.
- **A build that does not start.** The post-check restores the previous line, so
  the config never stays pointing at a broken build — unless that restore target
  was deleted in the meantime, in which case the config is left on the failed tag
  and the message names the key to fix by hand.

A hand-edited path can point at a build that does not exist (a mistyped tag). The
pipeline cannot: it only writes a path it has extracted, run and served from.

## 2. Manual — the agent procedure (fallback)

This is what an agent runs when asked to install a build by hand. You are
unattended: nobody will answer questions or approvals, and an action that is not
allowed is refused at once with a reason. Follow the steps, then end your final
message with the `RESULT:` line the runner expects.

You do **not** switch Forge onto the build: `llama_server.binary` lives in the
owner's `~/.forge/policy.yaml`, and no agent tool may write anything under
`~/.forge/`. The built-in updater above is the only thing that changes it. Your
report tells the owner the exact line to set.

### Inputs: the check observation

The job's check observation (below the task) is JSON with `tag` (for example
`b12211`) and `assets`, a list of `{ name, digest }` where `digest` is
`sha256:<hex>`. You need no web lookup: everything comes from it.

Pick two assets:

- **main zip:** `llama-<tag>-bin-win-cuda-<ver>-x64.zip`, with the highest
  `<ver>` (compare as numbers: 13.5 > 12.4). Never an `arm64` one.
- **cudart zip:** `cudart-llama-bin-win-cuda-<ver>-x64.zip`, with the **same**
  `<ver>` as the main zip.

If either is missing, stop with `RESULT: failed — release <tag> has no
win-cuda x64 main+cudart pair`.

### Steps

Use the `shell` tool (PowerShell) for each step. Keep one program per command
line, as shown.

0. **Find the folder.** Run `echo $env:LOCALAPPDATA` once. It prints something
   like `C:\Users\<you>\AppData\Local`. Let `$D` be that path plus `\Forge`. From
   here on, **write that literal path** wherever the steps below say
   `$env:LOCALAPPDATA`; never the variable. The approval check cannot see where a
   variable points, so a delete written with one is refused, and no approval line
   can allow it.

1. **Already installed?** If `$D\llama.cpp-<tag>\llama-server.exe` exists, end
   with `RESULT: no_change — llama.cpp <tag> is already installed at <path>`.
2. **Download** both zips into `$D\staging\<tag>\`. First create that folder:
   `New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Forge\staging\<tag>"`.
   Then fetch each asset with one `curl.exe` call:
   `curl.exe -fL --retry 3 -o "$env:LOCALAPPDATA\Forge\staging\<tag>\<asset>" https://github.com/ggml-org/llama.cpp/releases/download/<tag>/<asset>`
3. **Verify** each file:
   `(Get-FileHash "$env:LOCALAPPDATA\Forge\staging\<tag>\<asset>" -Algorithm SHA256).Hash`
   It must equal the observation's digest hex, ignoring case. On a mismatch,
   delete that staging folder and stop with `RESULT: failed — SHA-256 mismatch
   for <asset>`.
4. **Extract** both zips into one new folder, `$D\llama.cpp-<tag>\`, main zip
   first:
   `New-Item -ItemType Directory "$env:LOCALAPPDATA\Forge\llama.cpp-<tag>"`
   `tar.exe -xf "$env:LOCALAPPDATA\Forge\staging\<tag>\<main zip>" -C "$env:LOCALAPPDATA\Forge\llama.cpp-<tag>"`
   then the same `tar.exe` line for the cudart zip. If `llama-server.exe` ends
   up in a subfolder rather than at the top of `llama.cpp-<tag>\`, report that
   path; do not move files around.
5. **Smoke test:**
   `& "$env:LOCALAPPDATA\Forge\llama.cpp-<tag>\llama-server.exe" --version`
   must exit 0 and print the build number (`<tag>` without its `b`).
   `& "...\llama-server.exe" --list-devices` must exit 0 and list at least one
   CUDA device. If either fails, stop with `RESULT: failed — smoke test:
   <what it printed>`. Leave the folder so the owner can look at it.
6. **Clean up** the downloads only:
   `Remove-Item -Recurse "$env:LOCALAPPDATA\Forge\staging\<tag>"`.

### Report

On success, end with exactly these two lines, filled in:

```
RESULT: ok — installed llama.cpp <tag> at C:\Users\...\AppData\Local\Forge\llama.cpp-<tag>\llama-server.exe (smoke test passed; not switched)
SWITCH: set llama_server.binary in ~/.forge/policy.yaml to that path, then /restart
```

Do not add `RESTART: yes`: nothing was switched, so there is nothing to restart.

### Do not

- Do not edit `config.yaml`, `~/.forge/policy.yaml` or anything under `~/.forge/`.
- Do not restart the backend or call `/restart`. You are running on it.
- Do not delete any existing `llama.cpp-*` folder. Old builds are the owner's to
  prune — the automatic updater prunes them itself after a switch.
- Do not chain programs with `;`, `|` or `&&` in one command line, and do not
  use `Invoke-WebRequest`: each step is one program, so the job's approval
  rules can name it.
- Do not ask the owner anything. If you cannot proceed, report `RESULT: failed`
  with the reason and stop.
