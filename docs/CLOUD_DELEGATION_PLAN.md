# Cloud Delegation Plan — let `ask_local_agent` reach configured cloud models

**Status:** IMPLEMENTED 2026-08-26 (`npm run ci` green: 1145 tests)
**Date:** 2026-08-26

## The problem

Inside a Forge turn the agent has no way to consult a cloud model it can
already chat with. Observed reasoning from a live session:

> But my tools don't have a direct "call OpenRouter" tool. Let me check what's
> available: `ask_local_agent` — only for local models, Ollama, or cli external
> agents; `web_fetch`; `web_search`.

That is accurate. `resolveDelegationTarget()` in
[eligibility.ts:74-79](../src/delegation/eligibility.ts#L74-L79) rejects every
cloud provider outright:

```
Delegation target "..." uses OpenRouter; cloud providers are not allowed for
local delegation.
```

Meanwhile `.forge/config.yaml` carries six OpenRouter models, an xAI model, and
two Cerebras (`openai-compatible`) models — all already reachable as the
*primary* model through `ProviderTurn` → `resolveCloudRequestTarget`. So the
capability, the auth, and the transport all exist; only the delegation
eligibility gate stands in the way.

## Is this allowed?

Yes. CLAUDE.md's hard stop permits "explicitly user-configured, opt-in
OpenAI-compatible cloud providers (`xai`, `openrouter`, `openai`,
`openai-compatible`)" with the key in SecretStorage. Delegating to one of those
models is the same outbound traffic to the same endpoint with the same key as
chatting with it — no new destination, no new secret, no telemetry. Nothing in
`docs/DELEGATION_UNBLOCK_PLAN.md` or the live-validation archive gives a reason
for the exclusion beyond "local delegation" being the original framing (the
gate is really about **VRAM capacity**, which cloud targets do not consume).

## Design

Three seams, all small.

### 1. `eligibility.ts` — a fourth provider kind

`DelegationTarget.provider` gains `'cloud'`:

```ts
provider: 'llama.cpp' | 'ollama' | 'cli' | 'cloud';
```

`isCloudProvider(provider)` returns a target with `provider: 'cloud'` instead of
throwing. Ollama cloud-routed models (`:cloud` tag) are **also** unblocked —
they reach the local daemon like any other Ollama target and auth is the user's
own `ollama auth login`. **As shipped they keep the existing pooled path**
rather than the no-hold branch: that path is the same one their primary-model
chat already uses, and `BackendPool` owns the daemon's warm/keep-alive
lifecycle, so routing around it for one target kind would have been a larger
and less proven change than this fix needed. A non-local Ollama *endpoint* is
still rejected — Forge holds no auth for someone else's daemon.

Rationale for a separate `'cloud'` label rather than reusing `'ollama'`: the
service branches on it to decide *hold vs no hold* and *key resolution vs
baseUrl only*.

### 2. `LocalDelegationService` — a no-hold branch

Today `ask()` has two paths: the `cli` early return, and the pooled path that
acquires a `DelegationHold` before streaming. Add a third, taken when the target
needs no local VRAM (`provider === 'cloud'`, or an Ollama cloud-routed model):

```
readContextFiles → buildRequest → resolveCloudRequestTarget(model, secrets)
                 → streamToBuffer(baseUrl, req, model, signal, apiKey)
```

- **No `backendPool.canDelegate` / `acquireForDelegation`.** There is nothing to
  evict and nothing to contend for; requiring a hold would make a cloud
  consultation fail whenever the local slot is busy, which is exactly backwards.
  (Ollama-cloud goes through the daemon, which holds no VRAM for it either.)
- **`streamToBuffer` gained an `apiKey` parameter**, forwarded to
  `streamModelChatCompletion`'s existing sixth arg. That is the only signature
  change.
- **New dep:** `secrets?: vscode.SecretStorage` on
  `LocalDelegationServiceDeps`, passed from
  [extension.ts:121](../src/extension.ts#L121) as `context.secrets`. Absent in
  existing tests, which keeps them compiling; a cloud target with no `secrets`
  fails with the resolver's own "no bearer token in SecretStorage" message.
- **Timeout:** cloud reasoning models routinely exceed the 120 s
  `DELEGATION_TIMEOUT_MS`. Add `CLOUD_DELEGATION_TIMEOUT_MS = 300_000` in
  `limits.ts` and select it alongside the existing `cli` branch. Still far under
  the CLI's 600 s.
- Result cap (`MAX_DELEGATION_RESULT_CHARS = 24000`) and output-token clamp
  (`HARD_MAX_DELEGATION_OUTPUT_TOKENS = 4096`) are unchanged — they bound the
  context cost to the primary turn, which is provider-independent.

Error text stays inside the existing `DelegationError` wrapping, so a missing
key or a 402 from OpenRouter surfaces verbatim in chat (no-fallback rule).

### 3. `localAgentTool.ts` — description and gate

- Description: "…a secondary local model, a configured cloud model (xAI,
  OpenRouter, OpenAI-compatible), or a `provider: cli` external agent." The
  `model` arg description drops "must be a local … target".
- `hasEligibleDelegationTargets()` needs no change — it already returns true if
  *any* model resolves, and cloud models will now resolve.
- The no-targets error message ("Add a local llama.cpp or Ollama model") gains
  "or a configured cloud model".
- **Name stays `ask_local_agent`.** Renaming would invalidate the tool name in
  every prompt profile, session log, and test for a cosmetic gain; the
  description is what the model actually reads.

Permission stays `delegate`. A user who has not granted `delegate` cannot reach
cloud delegation, and a user with no cloud model in `config.yaml` has no cloud
target to reach — the opt-in is the config file, as it is for primary chat. No
new config flag: an extra `allow_cloud_delegation` toggle would gate a
capability the user already opted into twice (config entry + stored key).

## Test plan

New cases in `test/unit/eligibility.test.ts`:
- `openrouter` / `xai` / `openai-compatible` model → `provider: 'cloud'`, no throw.
- unknown provider still throws.
- Ollama `:cloud` model → resolves (previously threw).

New cases in `test/unit/LocalDelegationService.test.ts` (or a sibling
`LocalDelegationServiceCloud.test.ts` if the file nears 350 LOC):
- cloud target streams via injected `streamChat` with the resolved baseUrl and
  `apiKey`, and **never** calls `backendPool.acquireForDelegation`.
- cloud target with no stored key → error names the missing secret.
- cloud target respects the 300 s timeout constant, not 120 s.
- abort mid-stream still rejects with "Delegation cancelled".

`test/unit/localAgentTool.test.ts`: description mentions cloud; a config with
only an OpenRouter model advertises the tool.

## Files touched

| File | Change |
|---|---|
| `src/delegation/eligibility.ts` | `'cloud'` target kind; drop two throws |
| `src/delegation/limits.ts` | `CLOUD_DELEGATION_TIMEOUT_MS` |
| `src/delegation/LocalDelegationService.ts` | no-hold cloud branch, `secrets` dep, `apiKey` through `streamToBuffer` |
| `src/tools/localAgentTool.ts` | description + error text |
| `src/extension.ts` | pass `context.secrets` |
| `docs/OWNERS.md` | note delegation now spans cloud targets |
| tests | as above |

No new modules, no new deps. `LocalDelegationService.ts` is the only file that
grows meaningfully (~40 lines); it stays under the 500 LOC stop.

## Out of scope

- Giving delegated cloud models tools (they stay context-fed and tool-less, like
  local delegates; only `provider: cli` targets carry their own tools).
- A cost/spend guard. Worth a follow-up if cloud delegation gets used heavily —
  the natural shape is a per-turn delegation counter, not a price model.

## As-built notes

- `LocalDelegationService.canDelegate()` short-circuits to `{ ok: true }` for
  both `cloud` and `cli` targets — neither consults the pool, so pool capacity
  has no opinion about them.
- `selectDelegationTimeout(provider)` replaced the inline `cli ? … : …` ternary.
- `LocalDelegationService.ts` is now 405 lines — past the 350 soft threshold,
  under the 500 stop. The cloud branch sits inside `ask()` next to the `cli`
  branch it parallels; extracting it would split one three-way decision across
  files for ~30 lines.
- Cloud-path coverage lives in a new
  `test/unit/LocalDelegationServiceCloud.test.ts` (7 cases) rather than growing
  the existing service test file.
