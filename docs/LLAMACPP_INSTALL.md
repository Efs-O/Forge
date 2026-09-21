# Installing a new llama.cpp build

For the Forge agent and for people. Windows CUDA builds only.

## The one-call way: `install_llamacpp`

Ask the agent to "install the newest llama.cpp" and it calls `install_llamacpp`.
The call needs your approval. Then it:

1. finds the newest prerelease tag on `ggml-org/llama.cpp` (llama.cpp publishes
   its `bNNNN` builds as prereleases), or uses the `tag` you give it;
2. downloads the main zip matching `asset_pattern` (default
   `llama-*-bin-win-cuda-*-x64.zip`, newest CUDA version) and its matching
   `cudart` zip;
3. checks both SHA-256 digests against the release API, and refuses if either
   is missing or wrong;
4. extracts both into `%LOCALAPPDATA%\Forge\llama.cpp-<tag>\` (it will not
   overwrite an existing folder);
5. smoke-tests `llama-server.exe`: `--version` must report the build,
   `--list-devices` must run, and one embeddings request runs when embeddings
   are configured;
6. deletes the downloaded zips;
7. points `llama_server.binary` in `config.yaml` at the new build and keeps
   the file's comments (pass `switch_config: false` to skip this).

It does **not** restart the backend, because the model running the turn is that
backend. The new build takes effect on the next model load or `/restartBackend`.
Old build folders are kept, so rolling back means pointing `llama_server.binary`
at the previous folder.

It needs `jobs.allowed_hosts` in `config.yaml` to list `api.github.com`,
`github.com` and `release-assets.githubusercontent.com`. This is the same
download gate the scheduled `llamacpp_update` job uses, and both run the same
pipeline (`src/jobs/actions/llamacppInstall.ts`).

The tool is advertised only when `llama_server.binary` is set.

## Afterwards

- Models with their own `llama_server_binary` (for example a patched fork)
  keep that binary. Update those entries by hand if they should move too.
- Update any hard-coded tool paths, such as the `llama-tokenize.exe` path in
  `FORGE.md`, to the new `llama.cpp-<tag>` folder.

## Reaching folders outside the workspace

`read_file`, `create_directory` and `delete_file` normally stay inside the
workspace. To let them reach other folders, such as `%LOCALAPPDATA%\Forge` for
cleaning up old builds, list those folders in `config.yaml`:

```yaml
extra_file_roots:
  - C:/Users/<you>/AppData/Local/Forge
```

Entries must be absolute paths. Every write and delete still asks for approval.
`list_directory` already accepts any absolute path, and `query_powershell` does
not reach outside the workspace.
