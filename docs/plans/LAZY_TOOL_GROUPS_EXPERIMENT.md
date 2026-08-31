# Demand-Loaded Tool Groups — Experiment Report

**Status:** implemented, measured, validated live. 2026-09-01.
**Scope:** one rarely used MCP provider (HalluScribe). Not a tool-routing subsystem.

---

## The problem

HalluScribe's six MCP tools were advertised on **every single request**, whether
or not the conversation had anything to do with past sessions. Measured with the
Qwen3.8 tokenizer (`llama-tokenize --stdin --show-count`):

| Component | chars | tokens |
| --- | ---: | ---: |
| system prompt (execute.njk + FORGE.md) | 12643 | 3156 |
| native tools (62 advertised) | 35979 | 7733 |
| **halluscribe MCP tools (6)** | **10336** | **2382** |

2382 tokens is 18% of the static prefix, spent on a capability most coding turns
never touch. On the 27B's 58000-token single slot that is real context, and it is
paid at every round of every turn.

The obvious alternative — turning the tools off per model — was already in
`.forge/config.yaml` as the `halluscribe_tools_off` anchor. It saved the tokens
by making the archive permanently unreachable for that model. That is not the
same capability.

---

## What was built

A fresh conversation sees one small tool instead of six large ones:

```
load_tool_group({ group: "halluscribe" })
```

Calling it marks the group active **for that conversation**; the six real
schemas — byte-for-byte the ones HalluScribe publishes, never restated or
compressed by Forge — arrive through the normal `tools` array on the very next
round. The MCP server stays connected and dispatchable the entire time. Only
advertisement changes.

### Where it hooks in

| Concern | File |
| --- | --- |
| Which server is lazy; which tools it owns; which conversations activated it | `src/tools/lazyToolGroups.ts` |
| The `load_tool_group` tool itself | `src/tools/toolGroupTools.ts` |
| Records group membership as tools bridge in | `src/tools/mcpBridge.ts` |
| Filters the model-facing list | `src/sidebar/ModelTurn.ts` |
| Re-reads that list every round | `src/agent/ToolCallingLoop.ts` |

One map entry decides the whole policy:

```ts
const LAZY_GROUP_BY_SERVER = new Map([['halluscribe', 'halluscribe']]);
```

Every other MCP server advertises exactly as it always did.

### The one thing that had to change outside the filter

Forge computed `toolDefinitions` **once per turn** and passed a fixed array into
`runToolCallingLoop`. Activation mid-turn could therefore never reach the request
that followed it: the model would call `load_tool_group`, read "enabled", and
still see no HalluScribe tools — the precise failure mode CLAUDE.md warns about
under *a tool that lies costs more than a tool that fails*.

`ToolCallingLoopOptions.toolDefinitions` is now `getToolDefinitions()`, called
once per round. The context-budget math (`estimateToolTokens` in both
`prepareMessages` and `getOutputRoom`) reads the same live list, so the 2382
tokens are budgeted on the turn they actually appear rather than a round late.

### Ordering, and why the cache survives

`ToolRegistry.definitions()` follows `Map` insertion order. Natives register
synchronously at activation; MCP tools bridge in later as a background task, so
HalluScribe's six already sat at the *end* of the array. `load_tool_group` is
registered last among the natives. Activation therefore **appends** — the prefix
above it is byte-identical, and prefix caching recovers immediately after the one
transition round. A unit test asserts this rather than trusting it.

---

## Results

### Tokens

```
system prompt (execute.njk + FORGE.md)        12643 chars    3156 tok
native tools (62 advertised)                  35979 chars    7733 tok
load_tool_group (discovery, always on)          616 chars     125 tok
halluscribe MCP tools (6, on demand)          10336 chars    2382 tok

TOTAL static -- halluscribe UNLOADED          49238 chars   11014 tok
TOTAL static -- halluscribe ACTIVATED         59574 chars   13396 tok
```

**Recovered: 2382 tokens per request** on any conversation that never asks about
past sessions. **Permanent overhead: 125 tokens** — and zero for anyone without
HalluScribe configured, since `load_tool_group` suppresses its own advertisement
when no lazy group is bridged in.

Full per-tool breakdown: `test/prompt-context-measurement.txt`.

> The absolute totals are higher than the 12833 figure the experiment was
> specified against. That baseline predates growth in FORGE.md and one added
> native tool; the HalluScribe number is identical at 2382, so the delta is
> unaffected. Re-measure, do not diff against a stale total.

### Behaviour — the result that actually matters

The token arithmetic was never in doubt. The open question was whether a local
model recognises, from a ~125-token capability description alone, that a task
needs session history.

Validated live against Qwen3.8-27B (`test/live/LazyToolGroups.live.test.ts`, gated
on `FORGE_LIVE_LAZY_TOOLS=1`, real llama-server, real HalluScribe MCP server, no
prompt hinting of any kind):

| Prompt | Calls |
| --- | --- |
| "What did we decide about the Forge prompt cache in our previous sessions?" | `load_tool_group → search_sessions → read_session → read_tool_result ×3` |
| "Find the exact error we encountered previously with llama-tokenize." | `load_tool_group → search_sessions → search_raw_transcripts → search_sessions …` |
| "Read package.json and tell me which script `npm run ci` runs." | *(never called `load_tool_group`)* |

Both history questions opened with `load_tool_group` as the **first** call, then
went straight into the correct HalluScribe tool on the next round. The ordinary
coding request, in a separate conversation, left the group alone entirely and
`search_sessions` stayed absent from its tool list throughout.

The cost is exactly one extra tool round on the turns that need history.

---

## Activation lifetime

Per conversation, in memory only.

- Conversation A activates → stays loaded for the rest of A.
- Conversation B starts unloaded.
- Nothing is written to `config.yaml`. This is prompt shaping, not user
  configuration.
- A window reload drops activation while the conversation survives. The model
  re-activates: one round, not a bug. Documented rather than persisted, because
  persisting it would make a transient prompt decision outlive the reason for it.

---

## Config change that came with this

`.forge/config.yaml`'s `halluscribe_tools_off` anchor is **removed**, along with
its use on the `llamacpp-gemma4` group.

This was not tidying. Keeping both mechanisms would have been actively wrong: a
model carrying the anchor sees `load_tool_group` advertised, calls it, gets
"enabled" — and `ToolBudget.isExcluded` then swallows the six tools it just
enabled. That is the lying tool the per-round rebuild was added to prevent,
reintroduced through config. Gemma now behaves like every other model: hidden by
default, loadable on demand, which is strictly better than the anchor's
*off forever*.

Note that `.forge/` is gitignored (it carries machine-local model paths), so this
edit does **not** travel with the commit. Any other machine running Forge still
has the anchor and will hit the lying-tool path above until it is removed there
too — grep for `halluscribe_tools_off`.

---

## Tests

`test/unit/LazyToolGroups.test.ts` — seven cases: default exposure, activation,
persistence across rounds, isolation between conversations, unavailable server,
unrelated MCP servers unaffected, and prefix stability.

`test/unit/RegisterAllTools.test.ts` — asserts 63 tools *registered* but the
unchanged 62 *advertised*, so a future change that leaks `load_tool_group` into
the default list when no group exists fails loudly.

`test/live/LazyToolGroups.live.test.ts` — the live pass above.

Two repairs were needed along the way:

- `test/live/liveModelHarness.ts` had been calling a `ToolScope` API deleted from
  `ToolRegistry` long ago. It still *ran*, because `test/live/` is in no tsconfig
  and esbuild strips types — so `npm run ci` type-checks none of it. Worth
  remembering: green CI says nothing about the live harness compiling.
- That harness threw when it ran out of steps, discarding the record of what the
  model had called. It now returns `hitStepLimit: true`, matching the call
  `ToolCallingLoop` already makes for its round cap. The first live run "failed"
  purely because of this, while the transcript underneath showed the experiment
  working perfectly.

---

## Next: the same hierarchy test for the native tools

The experiment answers a narrower question than it can. HalluScribe was chosen
because it is one self-contained provider with an obvious trigger condition. But
the native catalog is **7733 tokens across 62 tools**, and the same reasoning
applies to any cluster of them that most turns never touch. Candidate groups,
straight off the per-tool measurement:

| Candidate group | Tools | Tokens |
| --- | --- | ---: |
| notebooks | `read_notebook`, `edit_notebook_cell` | ~202 |
| media | `view_image`, `view_video` | (already gated on vision) |
| git write | `create_branch`, `switch_branch`, `stage`, `commit` | ~342 |
| background execution | `monitor_execution`, `stop_execution`, `list_executions` | ~396 |
| delegation | `ask_local_agent` | 697 |

`ask_local_agent` alone is 697 tokens — the single most expensive tool in the
catalog, and one that most turns never call.

**What would have to be true before doing this.** The HalluScribe result is
evidence for *one* group with a sharply distinct trigger ("this needs history").
It is not yet evidence that a model reliably picks the right group from four or
five compact descriptions, nor that it recovers when it loads the wrong one. The
honest next step is a **hierarchy test**: two or three groups advertised at once,
measuring both discovery rate and mis-selection rate, before anything native is
hidden. A wrong guess there costs a round *and* leaves the model reaching for a
capability it has been told does not exist — which the tool audit already shows
is the expensive failure (11 of 14 silent give-ups with no tool call at all).

Explicitly **not** on the table, per the experiment's own terms: task
classification, embeddings, semantic routing, or Forge guessing which tools the
model needs. The model asks; Forge answers. That is the whole design.

---

## Reverting

Delete the one map entry in `src/tools/lazyToolGroups.ts`. HalluScribe returns to
being advertised unconditionally and every other part of the system is unchanged.
The per-round `getToolDefinitions()` rebuild should stay regardless — a tool list
that cannot change mid-turn is a constraint nothing else benefits from.
