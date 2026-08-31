# Capability Gaps vs Tool Failures — 2026-08-31

**What this covers:** the `query_powershell list_processes` change, the
measurement that justified it, and why the method used to find it should replace
the one used for everything before it.

**Related:** `docs/plans/TOOL_ERROR_PROMPT_PLAN.md` (the same day's work on error
strings, measured and largely disconfirmed — read its Outcome section first).

---

## Summary

| Change | Measured effect |
|---|---|
| `query_powershell` gains `list_processes` | **0 of 14 → 14 of 14** on the task it serves |
| Bare process name substring-matched | Removes a silent empty result on 4 of 14 sampled calls |
| Tool error strings rewritten (earlier) | **No measurable effect** |

Two of the three shipped changes helped. The one predicted to be the largest
win did nothing. The reason is the subject of this report.

---

## What was wrong

`exec_command` refuses `powershell -Command`. That ban is load-bearing:
`exec_command` spawns with `shell: false` and guards by inspecting argv tokens,
so an arbitrary script inside one string argument would walk past the denylist
and every other guard with it. It is also cheap — 24 occurrences in 9,607
audited calls, 92% recovered on the next call.

The ban was never the problem. **The alternative was.** FORGE.md taught `wmic`,
which on this machine answers:

```
$ wmic /?
WMIC is deprecated.
```

It still runs on Windows 10 19045 and is being removed from Windows 11. So the
capability the agent kept reaching for — "what processes are running, and with
what command line" — had a blocked front door and a back door being bricked up.

---

## The measurement

Live Qwen3.8-27B (llama-server on `:8080`), 14 seeds per arm, identical task —
*"Which llama-server processes are running, and with what command line?"* — the
only difference being whether `list_processes` was offered.

| next action | BEFORE | AFTER |
|---|---:|---:|
| used `query_powershell: list_processes` | — | **14** |
| reached for the banned `powershell` | 2 | 0 |
| **no tool call at all — answered in prose and stopped** | **11** | 0 |
| malformed `exec_command` | 1 | 0 |

### The finding that matters

Eleven of fourteen BEFORE runs produced **no tool call**. The model did not
fight the ban, hunt for a workaround, or retry. It answered in text and stopped.

**Those turns appear nowhere in the 9,607-call audit, because the calls were
never made.** A missing capability does not fail loudly. It stops being
attempted, and the transcript looks like the model simply chose not to bother.

This is the same shape as the `delete_file` finding in CLAUDE.md — 0 calls in
~3,000 while the agent reached for shell `rm` — except worse, because there was
no substitute call to notice either.

---

## What shipped

`src/tools/safePowerShellTool.ts`, ~16 lines of production code.

- Returns `ProcessId`, `Name`, `CommandLine` via `Get-CimInstance Win32_Process`.
- The name pattern is matched with `-like` **against the environment variable** —
  a comparison *value*. A WQL `-Filter` would have meant splicing model input
  into query source, which is the single thing that script exists to prevent.
- The name is **required, not optional**. `query_powershell` is `autoApprove`
  and bypasses the confirmation gate; an unbounded dump of every command line on
  the machine — some programs take tokens as CLI arguments — must not be one
  un-gated call away. Wildcards cover the real use.
- Argument validation runs before workspace resolution, so a bad argument
  reports itself rather than surfacing as whatever the workspace state is.
- A name containing no `*` or `?` is substring-matched. `-like 'llama-server'`
  never matches `llama-server.exe`, and the empty result reads as *"nothing is
  running"* — a plausible wrong answer, which is the one failure shape an agent
  cannot recover from. 4 of the 14 sampled calls passed the bare name.

FORGE.md points at the operation and warns off `wmic`.

Commits: `c0fdff3`, `46818fa`. CI green at 1,499 tests.

---

## The two failure shapes, and which one to hunt

Today produced one rule worth keeping and one worth retiring.

**Retired: failure rate as a health signal.** Measured recovery on the next
call: `commit` nothing-staged 100%, `exec_command` shell operators 100%,
`-Command` refusal 92%, `list_directory` ENOENT 81%, `read_file` ENOENT 77%.
Roughly 2.6% of all rounds go to recoverable misses. That is what exploration
costs, not a defect. A tool failing 10% of the time that always recovers is
healthy.

**Kept: two shapes are genuinely dangerous, and neither shows up as a high
failure rate.**

1. **The plausible wrong answer.** `ask_user` returning `(cancelled)` when the
   box was never seen — 1 real answer in 16 lifetime calls. There is nothing to
   recover from, because it does not look like an error. The model believed the
   user had declined and stopped. `list_processes` returning an empty list for
   a bare name is the same shape, caught before shipping.
2. **The silent give-up.** A capability that is not reachable stops being
   attempted. Invisible to every log-based method, because the evidence is the
   *absence* of calls.

---

## Future test: exercise every tool (not yet done)

Log auditing cannot find shape 2. It can only see calls that were made. The
0→14 result above was invisible to a 9,607-call audit, and there is no reason to
think it is the only one.

**Proposed:** a capability probe across the whole tool surface. For each tool,
one realistic task drawn from actual workflows on this machine — the Ssuno film
work, ComfyUI/video, GGUF handling and llama.cpp lifecycle, git, the Forge repo
itself — run against the live local model with the tool present and with it
absent, and record:

- did it call the right tool, a wrong tool, or **nothing at all**;
- for tools with required arguments, did it get the argument shape right first
  time (the bare-name bug above was found exactly this way);
- for tools returning empty/zero results, is that outcome distinguishable from
  a genuine "none found".

**What it is looking for**, in priority order:

1. Tasks the model abandons silently — the shape this report found.
2. Tools whose empty result is indistinguishable from a real answer.
3. Tools never selected despite being applicable — a description problem, and
   the only category where prose in a description is the right fix.

**Explicitly not looking for** failure rates. That question is answered.

**Cost:** low. The harness already exists — a direct `/v1/chat/completions` call
against `:8080` with a tool array and n seeds per arm; the scripts used for both
measurements in this report are the template. The expensive part is writing one
honest task per tool, and that is a person's judgement about real workflows, not
something to generate mechanically.

**Prerequisite:** run it *after* a window reload, against a known build. The
extension host serves the pre-reload code, so a probe run against a stale host
measures the wrong binary.

**Caveat this report cannot resolve:** n=14 per arm at temperature 0.7 is enough
to separate 0 from 14. It is not enough to detect a small effect — which is
exactly why the error-string change reads as "no measurable effect" rather than
"no effect". A probe sweep should size its n to the size of the difference it
expects to matter.
