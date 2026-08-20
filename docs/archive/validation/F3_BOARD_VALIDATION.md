# F3 — Live Board Validation (cloud worker via Forge `/chat`)

Status: **PASS** — live-validated 2026-06-13. Closes the "F3 manual board
validation still pending" item. Pairs with the F3 code in `F3_CHAT_PROXY_PLAN.md`
(Forge) and `forge-relay/F3_RELAY_CHAT_ROUTING_PLAN.md` (Relay).

Environment: Forge `0.12.22` (control server :8799 with `POST /chat`), Forge
Relay `0.3.20` (board :7878, F3 `forge-chat` routing). Both freshly installed +
window reloaded; a stale pre-F3 control-server process (orphaned on :8799 from an
earlier session) had to be killed first — see "Gotchas".

## Test 1 — Forge-side direct `/chat` proxy (key host-side, tools, OpenAI shape)

`POST :8799/chat` with `model: openrouter/free`, a `get_time` tool, no API key in
the request. Result:

```json
{"model":"openrouter/free","choices":[{"index":0,"message":{
  "role":"assistant","content":"","reasoning":"We need to call get_time.",
  "tool_calls":[{"id":"...","type":"function","function":{"name":"get_time","arguments":"{}"}}]},
  "finish_reason":"tool_calls"}]}
```

PASS: OpenAI-compatible `{choices:[{message:{content,reasoning,tool_calls},finish_reason}]}`,
`tool_calls` forwarded, `finish_reason:"tool_calls"`, and the OpenRouter key
resolved **host-side from SecretStorage** (request carried none).

## Test 2 — Board dispatch, cloud worker writes a file end-to-end

`dispatch_subagent { agent:"claude-code", model:"openrouter/free", tools:"full",
mode:"sync", task:"create F3_BOARD_PROOF.txt …" }` on board :7878. Board events:

- `started [sa_mqcd9a9] sync clanker (forge-chat:openrouter/free) (cloud via Forge /chat)`
- `write_file F3_BOARD_PROOF.txt: WROTE F3_BOARD_PROOF.txt (21 bytes)`
- `SUBAGENT … (openrouter/free, clanker) COMPLETED (2 steps, 1 tool calls): Done.`

PASS: cloud model routed `forge-chat` → Forge `/chat`, ran the **full agentic
tool loop**, wrote the file (verified on disk). Board identity `worker-1:openrouter/free`
is model-qualified (F2 fix holds).

## Test 3 — Draft/readonly gate blocks writes

Same worker, `tools:"readonly"`, asked to write a file. Result:

- `SUBAGENT … (openrouter/free, draft) COMPLETED (1 steps, 0 tool calls)`
- worker reported: *"the available tools do not include a `write_file` function …
  I can only read files, list directories, search code, or propose diffs."* `[draft mode (no writes)]`

PASS: no `write_file` tool exposed in draft tier; target file never created.

## Gotchas

- Forge's control server runs in a VS Code **utility node process**
  (`--utility-sub-type=node.mojom.NodeService`). It can be orphaned across window
  reloads and keep holding :8799 with stale code, so a newly-installed build's
  control server can't bind and the old one keeps answering. Symptom: `/chat`
  returns `no route for POST /chat` while `/unload`/`/ensure` work. Fix: confirm
  the :8799 owner PID, kill it, fully close other VS Code windows opened before
  the install (they keep an older version in memory), reload.
- A VSIX whose **version number was not bumped** can mask stale code (installed
  relay `0.3.19` lacked the merged F3 routing). Bump the version when validating.
- MCP-over-SSE: the dispatch result returns on the **SSE channel**, not the POST
  (which 202-Accepts). Keep the SSE connection open while polling for the result.
