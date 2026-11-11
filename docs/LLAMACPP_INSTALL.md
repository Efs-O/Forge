# Installing a new llama.cpp build

For the Forge agent and for people. Windows CUDA builds only.

## The job way: `llamacpp_update`

This machine's `llama-updates` job is an agent job instead: it installs and
smoke-tests a build by following `docs/LLAMACPP_UPDATE.md`, and the owner
switches `llama_server.binary` in `~/.forge/policy.yaml`. The built-in action
below also switches, from Forge's own code.

A job whose action is `llamacpp_update` runs on its schedule, or now when you
ask the agent to run it (`manage_jobs` `run_now`). It:

1. finds the newest prerelease tag on `ggml-org/llama.cpp` (llama.cpp publishes
   its `bNNNN` builds as prereleases);
2. downloads the main zip matching the job's `asset_pattern` and its matching
   `cudart` zip;
3. checks both SHA-256 digests against the release API, and refuses if either
   is missing or wrong;
4. extracts both into `%LOCALAPPDATA%\Forge\llama.cpp-<tag>\`;
5. smoke-tests `llama-server.exe`;
6. stages the build, and switches `llama_server.binary` to it on an idle
   scheduler tick, keeping the file's comments and the build it replaced.

The pipeline is `src/jobs/actions/llamacppInstall.ts` (stages 2-5) and
`src/jobs/actions/llamacppUpdate.ts` (staging, switch, rollback). The new build
takes effect on the next model load, or at once after `/restart`.
Old build folders except the one replaced are deleted after a switch, so
rolling back means pointing `llama_server.binary` at that previous folder.

It needs `jobs.allowed_hosts` to list `api.github.com`, `github.com`,
`objects.githubusercontent.com` and `release-assets.githubusercontent.com`:
the gate is re-checked on every redirect, and GitHub serves a release asset
from one CDN or the other, so adding only three still fails at the hop.

## Afterwards

- Models with their own `llama_server_binary` (for example a patched fork)
  keep that binary. Update those entries by hand if they should move too.
- Update any hard-coded tool paths, such as the `llama-tokenize.exe` path in
  `FORGE.md`, to the new `llama.cpp-<tag>` folder.

## Reaching folders outside the workspace

`read_file` and `view_image` read any path on disk. `delete_file` and the
file-writing tools normally stay inside the workspace. To let them reach other
folders, such as `%LOCALAPPDATA%\Forge` for
cleaning up old builds, list those folders in `config.yaml`:

```yaml
extra_file_roots:
  - C:/Users/<you>/AppData/Local/Forge
```

Entries must be absolute paths. Every write and delete still asks for approval.
`list_directory` also accepts any absolute path.
