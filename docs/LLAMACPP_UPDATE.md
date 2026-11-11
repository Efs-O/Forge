# Updating llama.cpp (the how, for the agent)

This is the procedure the `llama-updates` scheduled job's agent follows. You are
running unattended: nobody will answer questions or approvals, and an action
that is not allowed is refused at once with a reason. Follow the steps, then end
your final message with the `RESULT:` line the runner expects.

## What you are doing

Install the newest llama.cpp Windows CUDA build into
`%LOCALAPPDATA%\Forge\llama.cpp-<tag>\` and check that it runs. You do **not**
switch Forge to it: `llama_server.binary` lives in the owner's
`~/.forge/policy.yaml`, which no agent can write. The owner switches. Your
report tells them the exact line to set.

## Inputs: the check observation

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

## Steps

Use the `shell` tool (PowerShell) for each step. Keep one program per command
line, as shown.

0. **Find the folder.** Run `echo $env:LOCALAPPDATA` once. It prints something
   like `C:\Users\<you>\AppData\Local`. Let `$D` be that path plus `\Forge`. From
   here on, **write that literal path** wherever the steps below say
   `$env:LOCALAPPDATA`; never the variable. The approval check cannot see where a
   variable points, so a delete written with one is refused, and no approval
   line can allow it.

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

## Report

On success, end with exactly these two lines, filled in:

```
RESULT: ok — installed llama.cpp <tag> at C:\Users\...\AppData\Local\Forge\llama.cpp-<tag>\llama-server.exe (smoke test passed; not switched)
SWITCH: set llama_server.binary in ~/.forge/policy.yaml to that path, then /restart
```

Do not add `RESTART: yes`: nothing was switched, so there is nothing to restart.

## Do not

- Do not edit `config.yaml`, `~/.forge/policy.yaml` or anything under `~/.forge/`.
- Do not restart the backend or call `/restart`. You are running on it.
- Do not delete any existing `llama.cpp-*` folder. Old builds are the owner's to
  prune.
- Do not chain programs with `;`, `|` or `&&` in one command line, and do not
  use `Invoke-WebRequest`: each step is one program, so the job's approval
  rules can name it.
- Do not ask the owner anything. If you cannot proceed, report `RESULT: failed`
  with the reason and stop.
