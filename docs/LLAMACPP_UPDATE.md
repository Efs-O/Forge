# Updating llama.cpp (the how, for the agent)

This is the procedure the `llama-updates` scheduled job's agent follows. You are
running unattended: nobody will answer questions or approvals, and dangerous
actions are denied at once. Follow it, then end your final message with the
`RESULT:` / `RESTART:` lines the runner expects.

## What you are doing

Point `llama_server.binary` in `config.yaml` at the newest llama.cpp Windows
CUDA build, and tell the runner to restart the backend on it. The runner does
the restart (step 7 of `docs/plans/AGENT_TASK_JOBS_PLAN.md`) *after* your turn
ends — you must not restart the backend yourself, because you are running on
it.

## The one call: `install_llamacpp`

Call `install_llamacpp` with the asset pattern this machine uses. It downloads
the main zip and its matching `cudart` zip, verifies both SHA-256 digests
against the release API, extracts into `%LOCALAPPDATA%\Forge\llama.cpp-<tag>\`,
smoke-tests `llama-server.exe` (`--version`, `--list-devices`, and one
embeddings round-trip when embeddings are configured), deletes the downloaded
zips, and — by default — points `llama_server.binary` at the new build with the
file's comments preserved. Old build folders are kept.

```
install_llamacpp
  asset_pattern: "llama-*-bin-win-cuda-*-x64.zip"
```

- Omit `tag` to install the newest prerelease (llama.cpp publishes its `bNNNN`
  builds as prereleases). The check's observation names the tag and asset; use
  it if it gives a specific tag.
- `asset_pattern` is the one that used to live in the job file; it is here now.
  It selects the newest CUDA build. The matching `cudart` zip is picked
  automatically.
- Leave `switch_config` at its default (`true`) so the binary is switched.
- It needs `jobs.allowed_hosts` to list `api.github.com`, `github.com` and
  `release-assets.githubusercontent.com`. This machine's config already has
  them. If the call reports that the host list is empty or a host is missing,
  stop and report `RESULT: failed — jobs.allowed_hosts is missing <host>`; do
  not edit the config yourself.

## After the call

- **Success** (the binary was switched): end with
  ```
  RESULT: ok — installed llama.cpp bNNNN
  RESTART: yes
  ```
  The runner restarts the backend on the new binary. If the new binary does not
  come up, the runner restores `config.yaml` from its pre-turn snapshot and
  restarts on the old binary, and reports that.
- **No new release / nothing changed** (the check said so, or the install found
  nothing newer): end with `RESULT: no_change — <what you saw>`. Do not add
  `RESTART: yes`.
- **Failure** (download, digest mismatch, smoke test, or any error): end with
  `RESULT: failed — <one sentence naming what broke>`. Do not add
  `RESTART: yes`.

## Old build folders

`install_llamacpp` keeps the old build folders under
`%LOCALAPPDATA%\Forge\llama.cpp-<tag>\`. Do **not** try to delete them: pruning
is the owner's job, and a recursive delete is a dangerous action that is denied
in an unattended run. If you want to note that old builds are accumulating, say
so in the `RESULT` sentence; the owner prunes.

## Do not

- Do not restart the backend or call `/restartBackend`. You are running on it.
- Do not hand-download, hash or extract. Use `install_llamacpp`.
- Do not edit `config.yaml` by hand. The tool switches the binary for you.
- Do not ask the owner anything. If you cannot proceed, report `RESULT: failed`
  with the reason and stop.
