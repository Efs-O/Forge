# Claude Code Token Usage Audit — Forge sidebar vs. extension, and CacheWarden

**Date:** 2026-09-04
**Trigger:** Suspicion that running Claude Code through the Forge sidebar burns
roughly double the usage of the same work in the Claude Code VS Code extension.
**Verdict:** Not supported. Forge is ~0.57x the extension's cost per request.
The usage spike had a different cause. A separate, smaller leak was found in
CacheWarden.

---

## 1. Headline findings

1. **Forge is cheaper per request than the extension, not double.**
   Today: Forge 13,199 weighted cost-units/request vs. extension 22,981.
   Forge was **13.1%** of the day's billed cost; the extension **86.9%**.

2. **The 56% usage jump was concurrent extension sessions, not Forge.**
   In the same clock hour as the 18-request Forge system-info session (233k
   units), extension session `cbaabf2e` spent 1.33M units over 65 requests —
   5.7x more. The hour before burned 2.4M with Forge completely idle.

3. **The two numbers being compared were different quantities.**
   "232k tokens" and "52k tokens" are both *context-window occupancy at a
   moment*, not cumulative billing. Billing is the sum over every request in a
   session. The 232k session made 112 API requests; the 52k Forge session made
   18.

4. **Claude Code uses the 1-hour prompt cache, not the 5-minute default.**
   Measured: 10,454 of 10,455 cache writes were `ephemeral_1h_input_tokens`.
   This invalidates the premise CacheWarden is built on.

5. **CacheWarden's keep-alive pings are ~2.3% of total billed cost** and, under
   a 1-hour TTL, mostly defend a cache that had not expired.

---

## 2. Method

Ground truth is the Claude CLI's own per-request accounting in
`~/.claude/projects/**/*.jsonl` (`input_tokens`, `cache_creation`,
`cache_read_input_tokens`, `output_tokens`).

**Two traps that had to be handled first:**

- **Duplicate rows.** The transcripts write one row per *content block*, so an
  assistant message with text + a tool call logs its `usage` twice. The Forge
  system-info session shows 31 usage rows but only **18 real API requests**.
  Counting rows inflates everything ~1.7x. Deduped on `requestId`.
- **Contaminated origin detection.** Grepping for the Forge preamble string
  falsely flags any session where that source file was read (including this
  audit's own session). Sessions are classified by whether the *first user
  message* starts with `You are the selected external coding agent`.

**Cost weighting** (Opus, relative to base input):

```
weighted = input + cache_write_5m*1.25 + cache_write_1h*2 + cache_read*0.1 + output*5
```

Analysis scripts were throwaway (scratchpad, not committed). Re-derivable from
the formula above plus the two traps.

---

## 3. Forge vs. extension — the numbers

Today (2026-09-04), deduped, all sessions in every project directory:

| UTC hr | Forge | Extension |
|---|---|---|
| 06:00 | 0 | 865,835 (54 reqs) |
| 07:00 | 608,571 (49) | 2,224,025 (71) |
| 08:00 | 214,171 (13) | 182,206 (9) |
| 14:00 | 0 | **2,406,996 (106)** |
| 15:00 | **233,209 (18)** | **1,330,189 (65)** |

```
FORGE:  80 reqs, 1,055,951 cost-units (13.1%)
EXT  : 305 reqs, 7,009,251 cost-units (86.9%)
per-request avg — FORGE 13,199 | EXT 22,981
```

### Forge's caching is working correctly

Per-request trace of the system-info session (`e2879f39`, 4 user turns):

```
req 1  ctx= 31,629  read= 13,073  write= 18,554   <- cold start: system prompt + tools + CLAUDE.md
req 3  ctx= 32,076  read= 31,627  write=    447
req 6  ctx= 35,206  read= 34,072  write=  1,132
req29  ctx= 51,965  read= 47,841  write=  4,122
```

91–93% cache hit, chaining properly on 1-hour writes. The warm-process path in
`src/agents/CliAgentSession.ts` is doing its job — no cold-resume penalty.

### Two real (small) Forge overheads

- **~18.5k cache write per new conversation/model pair.** Unavoidable cold
  start, paid per Forge conversation — so many short sidebar chats cost more
  than one long one.
- **15-minute idle timeout** (`DEFAULT_CLI_IDLE_TIMEOUT_MS`,
  `src/agents/CliSessionRegistry.ts:29`) disposes the CLI process; the next turn
  respawns with `--resume`. Because the server cache lives **60** minutes, the
  process timeout is the binding constraint, not the cache. Raising it toward
  45–60 min would keep more turns on the cheap path.

  **Caveat: not observed firing.** No >15-min-gap respawn was found in the logs.
  The largest mid-session write spike came after a 7.9-minute gap
  (`read=13,191 write=40,937`), which is *under* the limit and therefore has
  some other cause — unexplained, worth a look. The savings estimate comes from
  reading the code, not from measurement.

---

## 4. CacheWarden (`N:\vs code apps\CacheWarden`)

### The premise no longer holds

`cacheWarden.ttlSeconds` defaults to **280**, documented as *"4:40, 20s before
the 5-min TTL"*. The README repeats it: *"Anthropic's prompt caching keeps your
conversation context hot for 5 minutes."*

5 minutes is the **API default**. Claude Code overrides it and buys the 1-hour
cache — 10,454 of 10,455 writes measured were `ephemeral_1h`:

```json
{"ephemeral_1h_input_tokens":11728,"ephemeral_5m_input_tokens":0}
```

**This was not wrong when written.** 5 minutes was correct before Claude Code
started purchasing the extended TTL. The platform moved under the extension.

### Why that makes most pings dead weight

- Cache actually survives: **60 min**
- CacheWarden stops pinging after: **~28–30 min**
  (`keepAliveMaxPings: 7`, `keepAliveDurationSeconds: 1800`)

The whole ping window sits *inside* the real cache lifetime:

| Return after… | Cache without pings | Pings helped? |
|---|---|---|
| < 60 min | alive | **No** — paid for nothing |
| 60–90 min | expired | **Yes** — window pushed out |
| > 90 min | expired | **No** — pinging already stopped |

Only the middle band wins, and it is the narrowest of the three.

### Measured cost

```
keep-alive requests : 1,077
  cache_read  = 89,686,017
  cache_write =  2,646,603
  output      =    614,530
  weighted    = 17,348,379 cost-units   (2.3% of total)

real work    : 32,651 requests = 749,644,892 cost-units
```

Average context dragged through each ping: **91,810 tokens**. Even at the 0.1x
cache-read rate that is ~16,108 cost-units per ping — re-anchoring means
re-sending the whole conversation, so pings are not free.

Ping cost by day (recent): 2026-08-28 2.52M · 2026-09-02 1.92M ·
2026-09-03 0 · 2026-09-04 433k.

### Proposed fix (one setting, not a rewrite)

- `cacheWarden.ttlSeconds`: **280 -> ~3300** (55 min) — one ping just before the
  real expiry instead of seven inside a window that never expired.
- `cacheWarden.keepAliveDurationSeconds`: must be **raised above 3300**, or the
  30-minute stop cuts off the single ping before it ever fires.

Same protection in the band where it genuinely helps, at roughly 1/7th the cost.
The README and the `ttlSeconds` description both need their 5-minute claim
corrected.

---

## 5. Open items for tomorrow

- [ ] Apply the two CacheWarden settings; re-measure ping cost after a few days.
- [ ] Fix the 5-minute claim in CacheWarden's README and `package.json`
      description. Consider detecting the TTL from observed `cache_creation`
      fields rather than hardcoding an assumption that the platform can change.
- [ ] Decide whether to raise `DEFAULT_CLI_IDLE_TIMEOUT_MS` (15 -> 45–60 min) in
      `src/agents/CliSessionRegistry.ts:29`. Low confidence in the benefit —
      instrument an actual >15-min-gap respawn first.
- [ ] Explain the `read=13,191 write=40,937` spike after a 7.9-minute gap in
      session `14794db1`. Under the idle limit, so the cause is unknown.
- [ ] Consider surfacing per-turn billed tokens for CLI agents in the Forge
      sidebar. There is no such display today (`src/llm/promptCacheStats.ts`
      covers only OpenAI-compatible providers), which is exactly what made
      context occupancy and cumulative billing easy to confuse.

---

## 6. Caveats

- Cost-units are a *relative* weighting for Opus, not dollars. On a subscription
  the same math applies to the rate-limit budget rather than a bill.
- Ping "episode" grouping used time gaps across all sessions at once, so
  per-episode ping counts (median 31, max 161) are inflated by parallel VS Code
  windows pinging together. Do not lean on that figure. The totals, the 1-hour
  TTL finding, and the 2.3% share are solid.
- Sessions predating the current transcript format may be undercounted.
