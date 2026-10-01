# High‑Risk Bugs and Design Flaws (2026‑09‑25)

## 1. Unblocked Destructive Git Command
- **Location**: `src/tools/DenyList.ts` – `isDestructiveGitCheckout` identifies `git checkout -- .` as unrecoverable but the command is **not** included in the built‑in deny list.
- **Failure scenario**: An agent can invoke `git checkout -- .` to irreversibly delete all uncommitted changes in the working tree. Because the command bypasses the denylist, no approval dialog appears, leading to permanent data loss of in‑progress work.
- **Verification**: The deny list only blocks `git reset`, `git clean -f`, and other patterns; `git checkout -- .` is allowed.

## 2. PowerShell Script Execution Not Blocked
- **Location**: `src/tools/DenyList.ts` – `checkPowerShellBan` only bans `-Command`, `-EncodedCommand`, `-enc`; `-File` flag is permitted.
- **Failure scenario**: An attacker can run `pwsh -File <script.ps1>` to execute arbitrary PowerShell code with the same privileges as the Forge process, potentially reading/writing any file the agent can access, exfiltrating data, or installing malware.
- **Verification**: Test `checkDenyList('pwsh', ['-File', 'watch.ps1'], getBuiltinDenyList())` returns `null` (allowed).

## 3. Recursive Force Delete via `delete_file` May Escape Intended Scope
- **Location**: `src/tools/DenyList.ts` – The alternative for `rm -rf` suggests using `delete_file`, which can be called on any path allowed by `extra_file_roots`.
- **Failure scenario**: If `extra_file_roots` is misconfigured or extended, `delete_file` could recursively delete user data outside the workspace (e.g., `C:/Users/efso office/AppData/Local/Forge`), causing data loss.
- **Verification**: `delete_file` is listed in `COMMAND_TOOLS` and is approved only after a confirmation dialog; however, the dialog may be bypassed or the agent may be coerced into approving, leading to unintended deletion.

## 4. Incomplete Shell‑Operator Detection
- **Location**: `src/tools/execHelpers.ts` – `SHELL_OPERATOR_TOKENS` only matches whole tokens (`&&`, `||`, etc.) but does not catch operators embedded in longer arguments or escaped variants.
- **Failure scenario**: An agent could craft an argument like `"cmd.exe /c echo hello && rm -rf"` where the operator is part of a larger string, bypassing detection and allowing shell‑like pipelines to be executed via `exec_command`.
- **Verification**: The guard only checks `arg.trim()` against a set of exact tokens; any operator not isolated will be missed.

## 5. Background Execution Leakage
- **Location**: `src/tools/execHelpers.ts` – `exec_command` with `background: true` returns an execution ID but may leave processes running if `monitor_execution` or `stop_execution` is not used.
- **Failure scenario**: Unmonitored background processes can accumulate, consuming CPU/memory, eventually causing the host to become unresponsive or crash.
- **Verification**: Background executions are not automatically terminated; only explicit `stop_execution` can clean them up.

## 6. Improper Handling of Long Output Truncation
- **Location**: `src/tools/execHelpers.ts` – `formatExecCommandOutput` returns a truncated view with a note, but the note may be overlooked by the model, leading to silent loss of critical exit‑code or error information.
- **Failure scenario**: When a command exceeds `max_output_chars`, the truncated output may hide an error message, causing the agent to believe the operation succeeded when it actually failed, potentially corrupting state.
- **Verification**: The note is included only if `dropped > 0`; if the model does not inspect the note, it may miss failure indicators.

## 7. Unrestricted Access to `extra_file_roots` Directories
- **Location**: `src/config/types.ts` – `extra_file_roots` lists absolute paths that `delete_file`, `create_directory`, and `read_file` can operate on, including user‑profile locations.
- **Failure scenario**: A compromised agent could delete or overwrite files in `C:/Users/efso office/AppData/Local/Forge` or the memory directory, corrupting persisted state or personal data.
- **Verification**: The config permits any path listed there; no additional safeguards are enforced beyond the denylist.

## 8. Model Binary Mismatch on `llama.cpp` Updates
- **Location**: `install_llamacpp` tool updates the binary but does not verify compatibility of `--device` splits with actual GPU capacities.
- **Failure scenario**: Updating to a newer binary that changes default device allocation (e.g., adding `CUDA2` to `--device`) may attempt to load a model on a GPU that lacks sufficient VRAM, causing an out‑of‑memory crash.
- **Verification**: The binary’s `--device` argument is taken directly from config without runtime validation of GPU memory budgets.

## 9. Config.yaml Manual Edits Not Synchronized with Runtime State
- **Location**: `config.yaml` is never overwritten automatically; `setActiveModel` only mutates in‑memory state.
- **Failure scenario**: A user may edit `active_model` manually in the file, but the running Forge process continues to use the previous model, leading to mismatched expectations between the agent and the actual loaded model, possibly causing incorrect behavior or crashes when calling APIs that no longer exist.
- **Verification**: The file reflects the last manual edit, not the runtime `active_model`.

## 10. Race Condition in Compaction Ledger File Writes
- **Location**: `src/sidebar/compactionLedger.ts` – Multiple write operations (`append_file`, `delete_file`) can be recorded concurrently without atomic coordination.
- **Failure scenario**: Simultaneous writes may result in an inconsistent ledger, causing the agent to think a file was restored when it was actually deleted, leading to corrupted state or data loss.
- **Verification**: The ledger updates are not atomic; `commit` and `restore_file` may interleave, producing an inconsistent record.
