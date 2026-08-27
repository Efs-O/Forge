# Tool Budget & Delegation Findings (2026-08-15)

Two open decisions, both raised while testing Qwen 3.8 in the sidebar:

1. Tool schemas consume ~7.4k tokens on every request. What is that, and how much
   of it can be recovered?
2. Qwen delegated to a local GGUF worker and the machine OOM'd. How do we stop
   that structurally?

Nothing here is implemented. Measurements are real; recommendations are not yet
acted on.

---

## 1. Measured tool footprint

Built by instantiating the real `ToolRegistry` against the live
`.forge/config.yaml`, and by speaking MCP stdio directly to the HalluScribe
binary and wrapping its tools exactly as `mcpBridge.ts` does.

| Source | Tools | JSON chars | ~Tokens |
|---|---:|---:|---:|
| Forge built-ins (live config) | 34 | 14,091 | **3,523** |
| Forge built-ins (default perms) | 44 | 18,039 | 4,510 |
| HalluScribe MCP | 6 | 10,373 | **2,594** |
| `SYSTEM_AND_TEMPLATE_OVERHEAD` | — | — | 200 |
| **Accounted** | | | **~6,317** |
| Observed on the bar | | | **~7,400** |

**~1.1k is still unexplained.** Most likely tools whose advertisement depends on
runtime state a static probe cannot reproduce — `ask_local_agent` only appears
when delegation has eligible targets, and the LSP tools depend on live VS Code
providers. Worth closing with a real per-turn log line before optimising.

### Forge's own tools are not bloated

Average ~104 tokens per tool. Largest:

```
 945 chars  ~237 tok  apply_line_edits
 663 chars  ~166 tok  read_file
 613 chars  ~154 tok  exec_command
 602 chars  ~151 tok  rename_symbol
 584 chars  ~146 tok  find_files
```

There is no prose to trim here. The cost is breadth (34–44 tools), not verbosity.

### HalluScribe is 4x more expensive per tool

Average ~432 tokens per tool, and **56% of its bytes are description prose**
(5,798 of 10,373 chars):

```
2975 chars  ~744 tok   (desc 2099 chars)  search_raw_transcripts
2663 chars  ~666 tok   (desc 1323 chars)  search_sessions
1817 chars  ~455 tok   (desc 1098 chars)  read_raw_session
1521 chars  ~381 tok   (desc  652 chars)  get_digest
 945 chars  ~237 tok   (desc  484 chars)  get_profile
 445 chars  ~112 tok   (desc  142 chars)  read_session
```

`search_raw_transcripts` alone costs 744 tokens — 3x Forge's largest built-in.
Forge passes `inputSchema` through verbatim, so this is the server's spend, not
Forge's.

On Qwen's 49,152 window HalluScribe is **5.3% of context on every request**,
whether or not it is ever called.

---

## 2. Options for the HalluScribe cost

**A. Remove it from this workspace.** Delete `mcp_servers: halluscribe` from
`.forge/config.yaml`. Recovers all 2,594 tokens. Zero code. Correct if local
models never search the archive — verify before assuming.

**B. Deny-list per model or group — works today, no code change.**
`ToolBudget` already treats a limit of `0` as "never advertise"
(`ToolBudget.ts` `isExcluded`), so tools can be dropped without enumerating an
allowlist:

```yaml
- name: qwen38-27b-mtp-q3km
  tool_call_limits:
    search_raw_transcripts: 0
    search_sessions: 0
    read_raw_session: 0
    read_session: 0
    get_profile: 0
    get_digest: 0
```

Keeps HalluScribe for models that want it. Static: changing it means editing
config.

**C. Profile-level tool control — small code change, gives "only when I ask".**
`ProfileConfig` currently has no `tools` / `tool_call_limits` (`types.ts:79-88`);
only `GroupConfig` and `ModelConfig` do. Adding both fields would let a profile
turn the archive tools on:

```yaml
profiles:
  archive:
    tools: [search_sessions, read_session, get_digest, ...]
```

Then `qwen38-27b-mtp-q3km` runs lean and `qwen38-27b-mtp-q3km@archive` gets the
archive, switched from the model picker with no config edit or reload. Profiles
already merge over model config, so this is mostly plumbing.

**D. Trim the descriptions at the source (HalluScribe repo).** Cutting six
descriptions to ~100 chars each saves ~1,300 tokens — about half the cost — and
benefits Claude Code and Codex too, which load the same six tools. Does not
require anything from Forge.

**E. Fold the six tools into one proxy with an `action` enum.** Cheapest
(~150 tokens) but conflicts with the standing rule in `CLAUDE.md` — *"No tools
with free-form `string` blob args (strict JSON schemas only)"* — because a proxy
needs an opaque `args` object, losing per-tool schema validation. Also adds a
discovery round trip, which is where small local models tend to guess arguments
instead of asking. Not recommended at q3 27B.

A middle path exists: keep strict schemas, shorten each description to one line
pointing at a `halluscribe_help` tool that returns full guidance as tool output
(paid only when called). That is D with a discovery affordance.

**Suggested order:** verify whether local models ever call HalluScribe → if not,
A. If yes, B now and C when convenient. D is worth doing regardless since it is
in your own server.

---

## 3. Local-worker delegation OOM

Qwen called for a second opinion, picked a local GGUF worker, and the machine ran
out of VRAM.

### Root cause

**`max_simultaneous_models: 4`** in `.forge/config.yaml`. The pool caps
concurrent models **by count, not by VRAM**, so a second GGUF was loaded next to a
27B q3 that was already filling the card. Nothing checked whether it fit.

**Compounded by the catalog.** `buildWorkerCatalog` advertises *every* model in
config, filtering only cloud entries when `cloud-worker` is not permitted
(`WorkerPrompts.ts:28-34`). The config holds **52 models**, of which exactly
**2** are `provider: cli` (`claude-code`, `codex`). The menu Qwen read was
overwhelmingly local GGUFs, so it picked one — as advertised.

### Options

1. **Filter the catalog to CLI targets.** A config option, e.g.
   `delegation: { local_targets: false }`, applied in `buildWorkerCatalog` *and*
   in `ask_local_agent` eligibility. The model cannot choose a local worker
   because it never learns they exist. Strongest fix, small change.
2. **`max_simultaneous_models: 1`.** Config-only, immediate, prevents a second
   GGUF loading at all. **Unverified:** what happens when delegation then
   requests a model that cannot load — it may error rather than degrade, and
   `LOCAL_AGENT_DELEGATION_PLAN.md` forbids evicting the primary mid-turn. Worth
   testing before relying on it.
3. **Prompt text** in `DELEGATION_INSTRUCTIONS` ("prefer codex/claude-code").
   Weakest lever: it leaves 50 usable targets advertised and relies on the model
   declining them. This session produced direct evidence that this model treats
   inconvenient instructions as optional — a 100-item validation checklist that
   affirmed three API parameters which were returning HTTP 400 at the time. Use
   as belt-and-braces, not as the mechanism.

A VRAM-aware pool limit is the principled fix but is a much larger job than
either 1 or 2.

---

## Not verified

- The ~1.1k unaccounted tokens. Needs a per-turn `[tool-budget]` log line
  reporting advertised tool count and schema tokens.
- Whether local models in this workspace ever call HalluScribe at all. Decides
  whether option A is simply correct.
- Behaviour of delegation under `max_simultaneous_models: 1`.
- Token figures are `chars / 4` estimates, matching how `postTokenBudget`
  computes the bar — not a real tokenizer. Treat as indicative.
