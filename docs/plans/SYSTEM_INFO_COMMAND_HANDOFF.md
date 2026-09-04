# `/system` Command — Handoff

Status: **design agreed, nothing implemented.** No code written, no files
touched other than this one. Written 2026-09-04.

## What the user asked for

A new slash command that reports the state of the machine:

- per-GPU VRAM usage and utilisation (both cards)
- system RAM
- drive free space
- **which processes are holding VRAM right now** — not every small consumer,
  mainly the CUDA / llama-server / ollama ones

The user confirmed two decisions on top of the initial proposal:

1. It must ship on **both** surfaces — the sidebar `/` menu **and** Telegram.
   Not sidebar-first.
2. **Also expose it as an agent tool.** Their reasoning, which is right: the
   agent will otherwise burn rounds shelling out to find the same numbers, so a
   dedicated tool is a shortcut, not a new capability. (See the
   `query_powershell list_processes` precedent in `CLAUDE.md` — adding a
   missing capability took that path from 0/14 to 14/14.)

They also asked, correctly: *"when I say processes I mean the pid right?"* —
yes. Every VRAM-consumer source below is keyed by PID; the process **name** is
a second lookup joined on that PID.

## Verified on this machine (2026-09-04) — read before designing anything

Two probes were run. Both results change the design, so do not re-derive them.

### 1. `nvidia-smi` per-process VRAM is `[N/A]` here, and the list is polluted

```
nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader,nounits
```

returned 15 rows, **every one with `[N/A]`** for `used_gpu_memory`, and the
rows include `explorer.exe`, `SearchApp.exe`, `Viber.exe`, `chrome.exe`,
`Code.exe`, `NVIDIA Overlay.exe`.

Two conclusions:

- The WDDM `[N/A]` caveat is **real on this exact box**, not theoretical. Per
  the driver, per-process dedicated VRAM is not exposed outside TCC mode.
- An earlier claim in the design discussion — that `--query-compute-apps` lists
  only genuine CUDA contexts and therefore needs no filtering — is **wrong**.
  It lists graphics clients too. Filtering is required, and it cannot be done
  by "is it in the compute-apps list".

Per-GPU aggregate numbers *are* reliable:

```
nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits
0, NVIDIA GeForce RTX 3060,     0, 12288,   0, 42
1, NVIDIA GeForce RTX 5060 Ti, 15868, 16311, 100, 67
```

Note `index` here is **nvidia-smi ordering**, which per `src/config/types.ts:286`
is *not* llama.cpp's CUDA ordering. Do not present it as `-dev N`.

### 2. Task Manager's numbers come from WDDM perf counters — and they work

The user pointed out Task Manager shows per-process GPU memory fine. It does,
because it reads the WDDM performance counters, not NVML. Confirmed working:

```powershell
(Get-Counter '\GPU Process Memory(*)\Dedicated Usage').CounterSamples
```

- **elapsed: 1646 ms** — this is the expensive part of the whole report.
- Instance names look like `pid_20336_luid_0x00000000_0x000134f8_phys_0`.
- `CookedValue` is **bytes**.
- Top row at probe time: `pid_20336` holding **14.70 GB**, which reconciles
  with nvidia-smi's `15868 MB used` on GPU 1. PID 20336 was
  `...\uv\python\cpython-3.13.13...\python.exe`. Second and third were 0.26 GB
  (`pid_1544`) and 0.25 GB (`pid_17280`, VS Code).

So: **this is the source to use for per-process VRAM.** The `[N/A]` caveat from
the original proposal is superseded — the report can show real per-process
numbers on Windows. Keep `nvidia-smi` for per-GPU totals, name, util, temp.

## Design

### Data sources

| Section | Source | Cost |
|---|---|---|
| GPUs (name, used/total, util, temp) | `nvidia-smi --query-gpu=...` | ~150 ms |
| Per-process VRAM | `Get-Counter '\GPU Process Memory(*)\Dedicated Usage'` | **~1.6 s** |
| PID → name / command line | one `Get-CimInstance Win32_Process` | ~0.5–1 s |
| RAM | `os.totalmem()` / `os.freemem()` | free, no subprocess |
| Drives | `Win32_LogicalDisk` where `DriveType=3`, folded into the same CIM call | free |

Run the nvidia-smi call and the PowerShell call in parallel under one
`AbortController` with a ~4 s deadline. Print the sections that answered and
say plainly which one timed out — no silent empty sections (`CLAUDE.md`: no
fallbacks unless requested).

### Filtering — the part the user actually cares about

Because the compute-apps list is polluted, filter on **magnitude**, from the
perf counter:

1. Take `\GPU Process Memory(*)\Dedicated Usage`, sort descending.
2. Drop anything under a threshold (~100–200 MB). The probe shows this cleanly
   separates the one real consumer (14.70 GB) from desktop noise (0.25 GB).
3. Resolve each surviving PID to a name via the CIM query.
4. Tag PIDs that Forge itself spawned.

### Open work item: Forge does not currently expose its own backend PIDs

`src/backend/DirectBackend.ts:292` only *logs* `pid=${proc.pid ?? '?'}`, and
`IBackendPool` in `src/backend/BackendPool.ts` has no PID accessor. So the
`(Forge backend: <model>)` tag needs a **small new accessor on the pool** — it
is not free. It is also the single most valuable line in the report, since it
is the one thing no external tool can tell the user, so it is worth the
accessor.

### Open question: LUID → GPU mapping

The counter instance name carries `luid_0x00000000_0x000134f8`, not a GPU
index. To attribute a process to *which* card, that LUID must be mapped to an
adapter. Unverified candidates: `\GPU Adapter Memory(luid_...)\Dedicated Usage`
totals reconciled against nvidia-smi's per-GPU `memory.used`, or the adapter
LUID in the display-class registry key. **Reconciling by total is probably the
cheapest reliable route** and needs no new data source. If it proves fiddly,
shipping the process list ungrouped (with a note) is acceptable for v1 — the
user's stated need is "which process is occupying the VRAM", not "on which
card".

### Output shape

Rendered as a `notice` row in the chat, **not** a model turn — zero tokens, no
backend required, `availableWhileStreaming: true` (it touches nothing the turn
owns).

```
GPU 0  RTX 3060          0.0 / 12.0 GB    0%   42°C
GPU 1  RTX 5060 Ti      15.5 / 16.0 GB  100%   67°C
  ├ 20336  python.exe        14.70 GB
  └ 17280  Code.exe           0.25 GB

RAM    38.4 / 64.0 GB used
N:     412 GB free / 1.8 TB   (workspace, models)
C:      88 GB free / 931 GB
```

## Wiring points (all located, none modified)

| Purpose | File |
|---|---|
| New owner module | `src/system/SystemReport.ts` (to create) |
| Command id union | `src/sidebar/messageBridge.ts:27` `ForgeSlashCommandId` |
| `/` menu entry | `webview-ui/src/slashCommands.ts` `SLASH_COMMANDS` |
| Sidebar dispatch | `src/sidebar/SlashCommandHandler.ts` `handle()` switch |
| Telegram dispatch | `src/remote/RemoteCommandHandler.ts` — add `command === '/system'` beside `/unload` (line 274) and `/restart` (line 285) |
| Fixed-script PowerShell pattern to copy | `src/tools/safePowerShellTool.ts:36-51` |
| Backend PID accessor | `src/backend/BackendPool.ts` / `src/backend/DirectBackend.ts:292` |
| Owner map row | `docs/OWNERS.md` |

Split `collectSystemReport(): Promise<SystemReport>` (typed struct) from
`formatSystemReport()`. Three consumers need the same data at different widths:
sidebar markdown, Telegram (tighter), and the agent tool (structured). That
split is the whole reason to build it inside Forge rather than telling the user
to run nvidia-smi.

## Agent tool — approved, ship in the same cycle

`get_system_status`, returning the structured `SystemReport`. Strict JSON
schema, no free-form string args. It widens the tool list every turn, which the
user accepted knowingly on the grounds that the agent would otherwise shell out
repeatedly for the same numbers.

## Constraints from `CLAUDE.md` that bind this work

- **No hardcoded OS paths** — resolve `nvidia-smi` from `PATH` only. Do not
  fall back to `C:\Windows\System32\nvidia-smi.exe`. If a rescue path is
  wanted, it is an optional config key.
- **No silent fallbacks** — nvidia-smi missing, or an AMD/no-NVIDIA machine,
  gets one clear line, not an empty section.
- 500 LOC hard cap per source file; 350 soft.
- Add the `docs/OWNERS.md` row in the same commit.
- Tests: unit tests against captured `nvidia-smi` CSV fixtures **including the
  `[N/A]` case** and captured `Get-Counter` instance-name strings.
- Stage files by name (`git add <path>`), never `git add -A`.

## Estimate

~180 LOC collector + ~60 formatter + wiring + the pool PID accessor + tests.

## Tree state at handoff

`main` @ `524d634`. The working tree is **not** clean despite what a session
hook may claim — it carries substantial unrelated in-progress work across
`src/remote/`, `src/voice/`, and `src/config/` (voice/whisper server and remote
handoff work). Check file mtimes before editing anything under `src/remote/`,
and do not assume a green or red `npm run ci` on this tree reflects your own
change.
