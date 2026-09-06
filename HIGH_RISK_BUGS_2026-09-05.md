# Forge — Top 18 High-Risk Bugs & Design Flaws

**Date:** 2026-09-05  
**Scope:** `n:\vs code apps\Forge` (VS Code extension, local LLM agent)

---

## 1. `atomicWrite` in `ConfigWriter.ts` is not atomic on POSIX — data loss on crash

**File:** `src/config/ConfigWriter.ts` (lines 79–95)

```ts
function atomicWrite(configPath: string, contents: string): void {
  const temporaryPath = `${configPath}.tmp`;
  const backupPath = `${configPath}.bak`;
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
  try {
    fs.writeFileSync(temporaryPath, contents, 'utf8');
    if (fs.existsSync(configPath)) fs.rmSync(configPath, { force: true });
    fs.renameSync(temporaryPath, configPath);
  } catch (err) {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    throw err;
  }
}
```

**Failure scenario:** The code deletes the original file **before** renaming the temp file into place. On POSIX, `rename` is atomic, but the window between `rmSync` and `renameSync` is **not**. If the process crashes or the disk fills between these two calls, `config.yaml` is gone and only the `.bak` backup (which is a copy of the **old** file) exists. The new content is lost. On Windows this is masked because `rename` is not atomic over an open file, but the same race exists on Linux/macOS.

**Fix:** Write to a temp file, then `rename` over the original (POSIX atomic rename). Only delete the original after the rename succeeds.

---

## 2. `write_file` and `append_file` have no path containment — arbitrary write outside workspace

**File:** `src/tools/builtinTools.ts` (lines 160–210)

```ts
handler: async (args) => {
  const filePath = resolveWorkspacePath(args['path'] as string);
  // …
  fs.writeFileSync(filePath, content, 'utf8');
}
```

`resolveWorkspacePath` **does not** enforce `mustBeInsideWorkspace` by default. A model-supplied absolute path like `C:\Users\victim\.ssh\authorized_keys` or `../../.forge/config.yaml` passes through unchanged.

**Failure scenario:** A prompt-injected model (or a model that hallucinates a path) can write to any location the VS Code process can write. This is a **data-loss / privilege-escalation** vector: overwrite `.gitconfig`, `.bashrc`, or the Forge config itself.

**Fix:** Pass `{ mustBeInsideWorkspace: true }` to `resolveWorkspacePath` in `write_file`, `append_file`, `edit_file`, `create_directory`, `move_file`, and `delete_file`.

---

## 3. `read_file` has no path containment — arbitrary file read outside workspace

**File:** `src/tools/builtinTools.ts` (line 88)

```ts
const filePath = resolveWorkspacePath(args['path'] as string);
```

Same issue as #2 but for reads. A model can read `C:\Users\victim\Documents\secrets.txt` or `/etc/passwd`.

**Failure scenario:** Information disclosure. A malicious or hallucinating model reads the user's SSH keys, API tokens, or the Forge config (which may contain API keys).

**Fix:** Same as #2 — enforce `mustBeInsideWorkspace: true`.

---

## 4. `killLlamaProcess` on Windows can orphan the process tree

**File:** `src/backend/llamaProcess.ts` (lines 24–65)

```ts
if (process.platform === 'win32' && proc.pid) {
  try { proc.kill(); } catch {}
  const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
    shell: false,
    stdio: 'ignore',
  });
  killer.once('exit', () => setTimeout(finish, 250));
  killer.once('error', () => setTimeout(finish, 250));
}
```

**Failure scenario:** `taskkill` is spawned with `stdio: 'ignore'`. If `taskkill` itself fails (e.g., the process is in a zombie state, or the PID is recycled to a different process), the error is swallowed. The `setTimeout(finish, 6000)` fallback resolves the promise regardless. The llama-server process may remain running, holding VRAM and ports, and the pool will believe the slot is free.

**Fix:** Check `taskkill` exit code; if non-zero, log and retry with `SIGKILL` equivalent. Do not resolve on `error` without verifying the process is actually gone.

---

## 5. `BackendPool.startSlot` — evicted backend `stop()` is fire-and-forget

**File:** `src/backend/poolStart.ts` (lines 50–65)

```ts
const swapped = evicted
  ? evicted.backend
      .stop()
      .catch(() => {})
      .then(() => backend.hotSwap(modelName))
  : backend.hotSwap(modelName);
```

**Failure scenario:** The comment says "fire-and-forget raced the two loads and OOM'd the GPU" but the code still does `.catch(() => {})` and then immediately calls `hotSwap`. If `stop()` takes longer than expected (e.g., the process is wedged), the new `llama-server` starts while the old one still holds VRAM. On a GPU with limited memory, this causes an OOM crash of the new server, or the old server is never killed and leaks VRAM indefinitely.

**Fix:** The comment claims the race was fixed, but the code still has the race. Await `stop()` before `hotSwap()`, or use a barrier.

---

## 6. `ToolLoopGuard.beforeRound` only blocks mutating tools — read-only loops are unbounded

**File:** `src/agent/ToolLoopGuard.ts` (lines 48–60)

```ts
beforeRound(calls: ToolCall[], isMutatingTool?: (name: string) => boolean): void {
  if (!calls.some((call) => isMutatingTool?.(call.function.name))) return;
  // …
}
```

**Failure scenario:** The guard returns immediately if **none** of the calls are mutating. A model that repeatedly calls `read_file` on the same file with slightly different line ranges (or `search_code` with the same query) will loop forever, burning context tokens until the turn is cut off. The `afterRound` check catches identical read-only rounds after 6 iterations, but by then 6 rounds of context have been wasted.

**Fix:** Apply the same 3-strike rule to read-only tools, or at minimum lower the threshold for read-only loops.

---

## 7. `RemoteTransportLease.heartbeat` — TOCTOU race on lease token verification

**File:** `src/remote/RemoteTransportLease.ts` (lines 115–135)

```ts
private async heartbeat(): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(this.filePath, 'r+');
    const previous = Buffer.from(await handle.readFile('utf8'));
    const current = LeaseSchema.parse(JSON.parse(previous.toString('utf8')));
    if (current.token !== this.record.token) {
      this.lose('Forge remote transport lease was lost; inbound control has stopped.');
      return;
    }
    this.record.heartbeatAt = Date.now();
    const serialized = Buffer.from(JSON.stringify(this.record), 'utf8');
    // …
    await handle.write(next, 0, next.length, 0);
  } catch (err) {
    this.lose(`Forge remote lease heartbeat failed: ${(err as Error).message}`);
  } finally {
    await handle?.close();
  }
}
```

**Failure scenario:** Between `readFile` and `write`, another process (e.g., a stale lease recovery from `acquire`) can rename the file and write a new lease. The heartbeat then overwrites the new lease with the old token, silently taking over remote control from the legitimate owner. The `verify()` check in `release()` is also racy.

**Fix:** Use a file lock (e.g., `flock` on POSIX, `LockFileEx` on Windows) or a compare-and-swap mechanism.

---

## 8. `checkDenyList` — `COMMAND_PREFIXES` allows `npm.cmd rm -rf .` on Windows

**File:** `src/tools/DenyList.ts` (lines 30–60)

```ts
const COMMAND_PREFIXES = new Set(['sudo', 'git', 'npx', 'pnpm', 'yarn', 'npm', 'run', 'exec']);

export function isRecursiveForceDelete(fullCommand: string): boolean {
  const tokens = fullCommand.split(/\s+/u).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== 'rm') continue;
    const previous = tokens[i - 1];
    if (previous !== undefined && !COMMAND_PREFIXES.has(previous)) continue;
    // …
  }
}
```

**Failure scenario:** On Windows, `npm.cmd` is a `.cmd` shim. The `canonicalizeExecCommand` function in `execProgramResolver.ts` maps `npm.cmd` → `npm`, but this only happens **after** the denylist check in some code paths. If the denylist sees `npm.cmd rm -rf .`, the token `npm.cmd` is not in `COMMAND_PREFIXES` (which has `npm`), so the check is skipped and the command is allowed.

**Fix:** Add `npm.cmd`, `npx.cmd`, etc. to `COMMAND_PREFIXES`, or canonicalise before the denylist check.

---

## 9. `edit_file` — `findEditMatch` can match across line boundaries in unexpected ways

**File:** `src/tools/editMatch.ts` (lines 40–60)

```ts
export function findEditMatch(content: string, oldStr: string): EditMatch | undefined {
  const exact = content.indexOf(oldStr);
  if (exact !== -1) return { index: exact, length: oldStr.length };

  const haystack = normalize(content);
  const needle = normalize(oldStr).text;
  if (!needle) return undefined;

  const hit = haystack.text.indexOf(needle);
  if (hit === -1) return undefined;

  const start = haystack.originOf[hit];
  const end = haystack.originOf[hit + needle.length];
  return { index: start, length: end - start };
}
```

**Failure scenario:** The `normalize` function collapses CRLF and lone CR to LF. If the file contains a lone CR (old Mac line endings) and `oldStr` is composed from a read that shows LF, the match can span across a CR that was collapsed, causing the replacement to delete the CR and shift subsequent content. The `originOf` mapping is correct for the normalized text, but if the file has mixed line endings, the match can be ambiguous.

**Fix:** Reject files with mixed line endings before editing, or require exact line-ending match.

---

## 10. `TerminalCommandTracker.readOutput` — unbounded memory growth on long-running commands

**File:** `src/tools/TerminalCommandTracker.ts` (lines 170–185)

```ts
private async readOutput(
  tracked: CapturedOutput,
  execution: vscode.TerminalShellExecution,
  limit: number,
): Promise<void> {
  let output = '';
  for await (const chunk of execution.read()) {
    if (output.length >= limit) {
      tracked.outputTruncated = true;
      continue;
    }
    const remaining = limit - output.length;
    output += chunk.slice(0, remaining);
    if (chunk.length > remaining) tracked.outputTruncated = true;
  }
  const clean = stripTerminalEscapes(output).trim();
  if (clean) tracked.output = clean;
}
```

**Failure scenario:** The `continue` statement skips appending to `output` once the limit is reached, but the `for await` loop **still reads every chunk** from the terminal execution. For a long-running command that produces gigabytes of output (e.g., `cat /dev/urandom` or a verbose build), the chunks are read and discarded, but the `execution.read()` stream is not closed. This can cause memory pressure in the VS Code extension host and keep the terminal process alive longer than necessary.

**Fix:** Break out of the loop once the limit is reached, or cancel the read stream.

---

## 11. `write_file` / `append_file` — no enforcement of `MAX_SINGLE_WRITE_CHARS`

**File:** `src/tools/builtinTools.ts` (lines 160–210)

```ts
export const MAX_SINGLE_WRITE_CHARS = 6000;

// In makeWriteFileTool:
handler: async (args) => {
  const filePath = resolveWorkspacePath(args['path'] as string);
  const content = args['content'] as string;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return `Written ${filePath}`;
}
```

**Failure scenario:** The `CHUNKED_WRITE_ADVICE` is included in the tool description, but there is **no runtime enforcement** of `MAX_SINGLE_WRITE_CHARS`. A model can still send a 50 KB write in a single call. If the context is tight, the tool call arguments will be truncated mid-string, causing a `ToolCallTruncatedError` and losing the entire turn. The `truncationRecovery.ts` module handles the error, but the damage is done — the turn is lost and the user must retry.

**Fix:** Add a runtime check in the handler that rejects content exceeding `MAX_SINGLE_WRITE_CHARS` with a clear error message, forcing the model to use chunked writes.

---

## 12. `truncationRecovery.ts` — `asTruncation` can misclassify a malformed tool call as truncated

**File:** `src/agent/truncationRecovery.ts` (lines 25–35)

```ts
export function asTruncation(err: unknown): ToolCallTruncatedError | undefined {
  if (isToolCallTruncatedError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (isNativeToolJsonParseError(message) && isTruncationParseError(message)) {
    return new ToolCallTruncatedError({ finishReason: 'length', message });
  }
  return undefined;
}
```

**Failure scenario:** Both a truncated tool call and a malformed tool call arrive from llama-server as the same HTTP 500 with "Failed to parse tool call arguments as JSON". The `isTruncationParseError` check inspects the error message for truncation indicators, but if the model generates a malformed JSON that happens to contain a truncation-like substring (e.g., a file path ending in `...`), the error is misclassified as a truncation. The recovery guidance then tells the model to use chunked writes, which is the wrong advice for a syntax error. The model retries with smaller chunks, still fails, and the turn is lost.

**Fix:** Improve the truncation detection to check for actual JSON truncation patterns (e.g., unterminated strings, missing closing braces) rather than substring matching.

---

## 13. `remoteStateFile.ts` — temp file cleanup race on crash

**File:** `src/remote/remoteStateFile.ts` (lines 25–40)

```ts
export async function writeRemoteStateFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temporary, filePath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (attempt >= 9 || !CONTENDED.has(code)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  } catch (err) {
    await fs.unlink(temporary).catch(() => undefined);
    throw err;
  }
}
```

**Failure scenario:** If the process crashes between `fs.writeFile(temporary, ...)` and `fs.rename(temporary, filePath)`, the temp file is left behind. The comment says "A temp file left behind would be indistinguishable from the ones a crash leaves" — but there is no cleanup mechanism for stale temp files. Over time, the `.forge/remote-inbox/` directory fills up with orphaned `.tmp` files, consuming disk space and potentially causing confusion if a later process tries to read them.

**Fix:** Add a startup cleanup that removes `.tmp` files older than a threshold (e.g., 1 hour) in the remote state directory.

---

## 14. `RemoteTransportLease.acquire` — stale lease recovery can lose a live lease

**File:** `src/remote/RemoteTransportLease.ts` (lines 55–75)

```ts
try {
  await RemoteTransportLease.createExclusive(filePath, record);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  const existing = await RemoteTransportLease.read(filePath).catch(() => undefined);
  if (existing && Date.now() - existing.heartbeatAt <= staleAfterMs) {
    throw new RemoteLeaseError('Forge remote transport is already owned by another window.');
  }
  const stalePath = `${filePath}.stale-${record.token}`;
  try {
    await fs.rename(filePath, stalePath);
    await RemoteTransportLease.createExclusive(filePath, record);
    await fs.unlink(stalePath).catch(() => undefined);
  } catch (recoveryError) {
    throw new RemoteLeaseError(
      `Forge could not safely recover a stale remote lease: ${(recoveryError as Error).message}`,
    );
  }
}
```

**Failure scenario:** The stale lease recovery checks `Date.now() - existing.heartbeatAt <= staleAfterMs`. If the heartbeat timer is slightly delayed (e.g., due to GC or system load), a live lease can appear stale. The recovery then renames the live lease file and creates a new one, silently taking over remote control from the legitimate owner. The old owner's heartbeat will then fail with a token mismatch and call `lose()`, but by then the new owner has already taken control.

**Fix:** Use a more conservative stale threshold (e.g., 3× heartbeat interval), or use a file lock to prevent concurrent access.

---

## 15. `BackendPool.release` — `stop().catch(() => {})` swallows errors

**File:** `src/backend/BackendPool.ts` (lines 159–162)

```ts
const backend = this.ollamaSlots.get(key);
if (backend) {
  await backend.stop().catch(() => {});
  this.ollamaSlots.delete(key);
}
```

**Failure scenario:** If `stop()` fails (e.g., the process is wedged or the port is in use), the error is swallowed and the slot is deleted from the map. The next `acquire` will create a new backend on the same port, which will fail to bind because the old process is still holding it. The user sees a confusing "port already in use" error with no indication that the old process is still running.

**Fix:** Log the error and retry `stop()` with a longer timeout, or keep the slot in the map until the process is confirmed dead.

---

## 16. `poolAcquisition.ts` — `slot.starting.catch(() => {})` swallows startup errors

**File:** `src/backend/poolAcquisition.ts` (lines 130–133)

```ts
if (slot.starting) await slot.starting.catch(() => {});
await slot.backend.stop();
```

**Failure scenario:** If `slot.starting` rejects (e.g., the llama-server failed to start due to a missing model file), the error is swallowed and the code proceeds to call `slot.backend.stop()`. The `stop()` call will fail because the backend was never started, and this error is also swallowed. The user sees no error message and the model appears to be unavailable with no explanation.

**Fix:** Propagate the startup error to the caller, or at least log it.

---

## 17. `LocalDelegationService.ts` — `acquire.then((lateHold) => lateHold.release()).catch(() => {})` swallows release errors

**File:** `src/delegation/LocalDelegationService.ts` (lines 311–314)

```ts
} catch (err) {
  if (signal.aborted) {
    void acquire.then((lateHold) => lateHold.release()).catch(() => {});
  }
  signal.throwIfAborted();
}
```

**Failure scenario:** If the delegation is aborted mid-acquire, the code attempts to release the late hold. If `release()` fails (e.g., the backend is wedged), the error is swallowed and the hold is never released. The backend slot remains occupied indefinitely, and subsequent acquire attempts will wait forever.

**Fix:** Log the error and retry `release()` with a timeout, or use a different mechanism to ensure the hold is eventually released.

---

## 18. `RemoteRuntime.ts` — `unlinkWhatsApp` mutates the active map outside the lifecycleTail

**File:** `src/remote/RemoteRuntime.ts` (lines 168–175)

```ts
async unlinkWhatsApp(): Promise<void> {
  const transport = this.manager.get('whatsapp');
  if (!transport?.channel.unlink) throw new Error('Forge remote WhatsApp is not running.');
  await transport.channel.unlink();
  // NOTE: mutates the active map outside the lifecycleTail (pre-existing
  // race, not introduced by the split). A concurrent applyConfig could
  // …
}
```

**Failure scenario:** The comment explicitly acknowledges a race condition: "mutates the active map outside the lifecycleTail (pre-existing race, not introduced by the split). A concurrent applyConfig could…" The `unlink()` call removes the WhatsApp transport from the active map, but a concurrent `applyConfig` could be in the middle of reading or writing to the same map. This can cause the `applyConfig` to see an inconsistent state, leading to a crash or a silent failure where the WhatsApp transport is lost.

**Fix:** Move the map mutation inside the `lifecycleTail` or use a lock to ensure mutual exclusion.

---

## Summary Table

| # | File | Risk | Severity |
|---|------|------|----------|
| 1 | `ConfigWriter.ts` | Data loss on crash during config write | High |
| 2 | `builtinTools.ts` | Arbitrary file write outside workspace | Critical |
| 3 | `builtinTools.ts` | Arbitrary file read outside workspace | Critical |
| 4 | `llamaProcess.ts` | Orphaned llama-server processes on Windows | Medium |
| 5 | `poolStart.ts` | GPU OOM from racing backend stop/start | High |
| 6 | `ToolLoopGuard.ts` | Unbounded read-only loops wasting context | Medium |
| 7 | `RemoteTransportLease.ts` | TOCTOU race on lease token | High |
| 8 | `DenyList.ts` | `npm.cmd rm -rf .` bypasses denylist | High |
| 9 | `editMatch.ts` | Ambiguous match across mixed line endings | Low |
| 10 | `TerminalCommandTracker.ts` | Unbounded memory growth on long output | Medium |
| 11 | `builtinTools.ts` | No runtime enforcement of write size limit | Medium |
| 12 | `truncationRecovery.ts` | Misclassification of malformed as truncated | Medium |
| 13 | `remoteStateFile.ts` | Temp file cleanup race on crash | Low |
| 14 | `RemoteTransportLease.ts` | Stale lease recovery can lose a live lease | High |
| 15 | `BackendPool.ts` | `stop().catch(() => {})` swallows errors | Medium |
| 16 | `poolAcquisition.ts` | `slot.starting.catch(() => {})` swallows errors | Medium |
| 17 | `LocalDelegationService.ts` | Release errors swallowed on abort | Medium |
| 18 | `RemoteRuntime.ts` | Race condition in `unlinkWhatsApp` | High |

---

*Report generated by Forge on 2026-09-05.*
