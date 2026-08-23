# Two-window smoke test (0.13.0, before merge)

The automated tests in this PR cover the *bookkeeping*: lease files, slot
tables, detach logic. They fake the llama-server with a plain HTTP server.

They do **not** cover the three things that only happen with a real one:

1. **VRAM** — that two windows sharing a model really do load the weights once,
   and that releasing does not free VRAM the other window is still using.
2. **A real process dying** — killing llama-server, or closing the window that
   owns it.
3. **The sidebar UI** — whether the model shows as ready, and whether Stop /
   Release actually do what the label says.

That is what this checklist is for. Budget 20–30 minutes.

---

## Setup

**1. Install the build.**

```powershell
code --install-extension .\forge-llm-0.13.0.vsix
```

Then **fully close and reopen VS Code**. Not "Reload Window" — the extension
host restart quietly reloads the *old* build, which has bitten this project
before.

**2. Turn shared runtime on** in `config.yaml`. It is off unless present:

```yaml
shared_runtime:
  enabled: true
```

**3. Clear stale state.** This release changes the runtime key format, so
anything already in there is from the old format and will just sit unused:

PowerShell — which is what the VS Code terminal gives you by default:

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\forge-llm\shared-runtimes" -ErrorAction SilentlyContinue
Test-Path "$env:LOCALAPPDATA\forge-llm\shared-runtimes"   # expect: False
```

Two things that trip this up: it is `$env:LOCALAPPDATA`, not `%LOCALAPPDATA%`
(PowerShell does not expand the `%...%` form — it passes it through as literal
text), and the flags are `-Recurse -Force`, not `/s /q`. The
`-ErrorAction SilentlyContinue` just keeps it quiet when the folder was never
created in the first place.

**4. Open two VS Code windows on two different folders.** Same folder twice
will not do — each window needs its own extension host. Call them **A** and
**B** for the rest of this document.

**Both windows must resolve to the SAME `config.yaml`.** Forge looks for
`.forge/config.yaml` in the workspace and falls back to the one in
globalStorage, so a window opened on a folder without `.forge/` may land on a
different config — and if the two configs disagree about the model at all, the
two windows compute different runtime keys and never share. That failure looks
exactly like the bug this release fixes, which makes it worth ruling out first.

If B is a folder with no `.forge/`, point it at A's config: `Ctrl+,` →
`forge.configFile` → **Workspace** tab → the absolute path to A's
`.forge/config.yaml`. Workspace scope, not User, so A keeps its normal lookup.
Reload B and confirm its model picker is actually populated before starting.

Do not solve this by *copying* the config into B. Two copies drift, and drift
is the thing that silently breaks sharing. One file, two readers.

**5. Have these ready to watch:**

- **Output panel → "Forge"** in both windows. This is the log referenced below.
- **Output panel → "Forge - llama-server"** — only the *owning* window shows
  live server output; the borrower shows a note saying so.
- A terminal running `nvidia-smi -l 2` to watch VRAM and process count.
- Explorer at `%LOCALAPPDATA%\forge-llm\shared-runtimes` — paste that into the
  Explorer address bar, where `%...%` *does* expand. One `<hash>.json`
  per shared server, and a `<hash>.leases\` folder holding one file per
  borrowing window.

**Noise you should expect and ignore.** With both windows on one config, the
second window logs:

```
[ControlServer] port 8799 in use — another Forge window likely owns it; not starting a second.
```

That is correct — only one window owns the control API port. Any configured
`mcp_servers` also spawn once per window, so you will see two of each in Task
Manager. Neither is a failure of this test.

---

## Test 1 — Two windows share one server

**Do:** Load the same local GGUF model in A. Wait for ready. Then load the
*same* model in B.

**Expect:**

- `nvidia-smi` shows **one** `llama-server.exe`, not two. VRAM does not double.
  This is the whole point of the feature — if VRAM doubles, stop and report it.

  > **Do not run a semantic search during this test.** Embeddings spawn a
  > *second* `llama-server` on port 8091 (EmbeddingGemma), which makes the
  > process count 2 for an entirely innocent reason and would read as a
  > failure here. It starts lazily and asks first, so simply declining the
  > prompt — or not searching — keeps the count honest. If one is already
  > running, check the port before counting: an embedding server is
  > `--embedding` on 8091, the chat server is not.

- B's Forge log: `adopting existing server` and `borrowed shared runtime`.
- One `<hash>.json` file appears, plus `<hash>.leases\` containing one file.
- B's sidebar shows the model as ready and **can actually answer a prompt.**
  Send one. A borrowed model that shows ready but errors on send is a failure.

**This is the fix for the readiness bug** — before 0.13.0, B could show the
model as loaded but not ready.

---

## Test 2 — The borrower releases (the main fix)

**Do:** In **B**, run `Forge: Unload Model` from the Command Palette.

> **Not `Forge: Release Model`** — despite the name, that command only
> decrements a control-server *hold* counter used by external API consumers
> (Relay calling `/ensure`). It frees no VRAM, no slot, and no lease. With no
> holds outstanding it reports "had no active holds" and does nothing.
> `Forge: Unload Model` is the one that tears down this window's backends.

**Expect:**

- B's log: `detached from adopted server`.
- **A's llama-server is still running.** `nvidia-smi` still shows the process;
  VRAM unchanged.
- B's lease file is **gone** from `<hash>.leases\`.
- A can still send a prompt and get an answer.
- Now run `Forge: Unload Model` in **A** — it should succeed, and the process
  should disappear from `nvidia-smi`.

**Before 0.13.0 this failed:** B's release threw an error, left its lease file
behind, and A could then never unload — it kept saying *"another Forge
workspace is using this shared runtime"* forever, even after B was closed.

---

## Test 3 — The borrower crashes

**Do:** Set up the share again (Test 1). Then kill window B the hard way —
Task Manager, end the VS Code process. Do **not** close it politely.

**Expect:**

- B's lease file is still sitting in `<hash>.leases\` immediately after (nobody
  cleaned up — expected).
- In **A**, run `Forge: Unload Model`. It **succeeds**.
- A's log shows `reclaimed stale runtime lease`.
- The lease file is gone and the server process is gone.

**This is the immortal-lease fix.** Before 0.13.0, A was stuck permanently and
the only cure was deleting the lease file by hand.

> **Partly automated now.** `test/integration/StaleLeaseRealProcess.test.ts`
> spawns real processes, force-kills them, and asserts the reclaim — so the
> pid check itself is covered on every CI run. What is still manual here is
> that the *server process* actually dies afterwards.

---

## Test 4 — The owner dies underneath the borrower

**Do:** Set up the share again. This time kill **A** hard (Task Manager),
leaving B running and pointed at a server that no longer exists.

**Expect:**

- B notices within about 5 seconds and stops reporting the model as ready.
- B does **not** sit there claiming to be ready and then hang on a prompt.
- Sending a prompt in B produces a clear error, or B starts its own server —
  either is acceptable. Silently hanging is not.
- `Forge: Unload Model` in B still works and removes B's lease.

This is the one with the least automated coverage. Take your time here.

---

## Test 5 — Kill the server itself

**Do:** With one window and one model loaded, kill `llama-server.exe` directly
in Task Manager.

**Expect:**

- Forge's log reports `exited unexpectedly` with a non-zero code.
- The model stops showing as loaded — Forge should not keep advertising a dead
  process.
- Sending a prompt either restarts it or errors clearly.

---

## Test 6 — The config change that needs a reload

**Do:** With a model loaded, edit `config.yaml` and change
`max_simultaneous_models` to a different number. Save.

**Expect:**

- A VS Code warning appears saying the setting defines the slot layout and the
  old value stays active until you reload the window.
- Nothing crashes; the loaded model keeps working.

---

## Test 7 — Old config still boots

**Do:** Add this to `config.yaml` and reload the window:

```yaml
permissions:
  agents:
    cloud_workers: true
```

**Expect:**

- Forge starts normally. **It must not fail to load.**
- A one-time warning says `cloud_workers` is deprecated and has no effect.

This matters because that key was valid before 0.13.0. If someone's existing
config now refuses to boot, that is a bad upgrade for every user who set it.

> **Automated now** in `test/unit/ConfigLoader.test.ts`, and the "must not fail
> to load" half is guaranteed by construction: the config schema ignores keys
> it does not recognise, so an unknown key can never block startup. Verified.
> Treat this one as done unless you want to see the warning text yourself.

---

## Test 8 — Re-borrow after the owner's server restarts

Added because the first real run of this checklist found a bug here that none
of tests 1–7 reach.

**Do:** Set up the share (test 1). Then kill `llama-server` directly, load the
model again in **A** so a fresh server comes up, and send a prompt in **B** so
it re-attaches. Now run `Forge: Unload Model` in **B**, then
`Forge: Unload Model` in **A**.

**Expect:**

- After B re-attaches, `<hash>.leases\` holds **exactly one** file, not two.
- A unloads successfully.

**The bug this catches:** B took a second lease on re-attach without releasing
the first. Releasing in B then removed only the newer one, leaving a file that
named B's own *live* process — so A saw a borrower that would never leave and
could not unload for as long as B stayed open. Two lease files for one window
is the tell; check the directory even if everything else looks fine.

Automated in `test/integration/SharedRuntimeReborrow.test.ts`, but the manual
version is what found it.

---

## Also worth confirming

`dispatch_workers` is gone in this release, but `ask_local_agent` is not. Ask
the model something like *"ask Claude to review this function"* and check it
still delegates — that is the capability you said you wanted kept.

---

## If something fails

Grab, in this order:

1. The **Forge** output channel from both windows.
2. The registry contents, leases included:

   ```powershell
   Get-ChildItem -Recurse "$env:LOCALAPPDATA\forge-llm\shared-runtimes" | Select-Object FullName, Length
   Get-ChildItem -Recurse -Filter *.json "$env:LOCALAPPDATA\forge-llm\shared-runtimes" | ForEach-Object { $_.FullName; Get-Content $_.FullName }
   ```

3. `nvidia-smi` output at the moment it went wrong.
4. Which test number, and what you expected versus what happened.

The session transcript in `~/.forge/sessions/` will *not* show tool or backend
failures — the rendered chat hides them. The output channel is the real record.

---

## Verdict

- **Tests 1, 2, 3 pass** → the three bugs this release exists to fix are
  genuinely fixed. Safe to merge and publish.
- **Test 4 or 5 fails** → report it; these are crash-recovery paths, worth
  fixing before publishing but they do not invalidate the rest.
- **Test 7** is covered by CI now — see the note under it.

**If you are short on time, do 1 and 2.** Those are the two that need real
VRAM and a real second window, and nothing automated can stand in for them.
