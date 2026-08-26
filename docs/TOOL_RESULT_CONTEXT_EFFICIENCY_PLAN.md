# Loss-Aware Tool-Result Context Management

**Status:** approved for benchmark-first implementation (2026-08-26)

## Problem

A Forge conversation keeps a complete transcript for the sidebar and session
persistence. The local model currently receives that same complete transcript
on every agent round. A large tool result can therefore make the *next* llama-
server request exceed the slot context even after `/compact` has reduced older
history. The visible token bar reports only the preceding successful request,
so it cannot warn about that unsent growth.

## Invariants

- Never modify, discard, or truncate the persisted/sidebar transcript.
- Hidden reasoning remains display-only and is not added to model context.
- Do not compact after ordinary tool calls.
- Any tool-result detail omitted from the model prompt remains exactly
  recoverable by the agent in bounded chunks within the same conversation.
- Never send a llama-server request already predicted to exceed its slot.

## Candidate policy

1. Build the normal model window: existing compaction summary plus retained
   messages and injected system prompt.
2. Reserve a usable response budget before dispatching a model round.
3. Only when the projected input would consume that budget, replace the
   largest tool-result bodies in the *model-only copy* with a faithful head and
   tail excerpt. The marker records the call ID, original size, retained byte
   ranges, and the exact `read_tool_result` call needed to fetch more.
4. Preserve recent/small tool results verbatim. The transform works from the
   largest result first and stops as soon as the prompt fits.
5. `read_tool_result` is a strict-schema read-only tool, scoped to the current
   conversation. It returns a bounded, exact character range from the raw
   stored tool result.
6. If the conservative estimate still cannot fit, stop locally with Forge's
   context-exhausted outcome and enter the existing compact/resume policy.
   Recognize the corresponding llama-server HTTP 400 too, as a defensive
   fallback.

## A/B evaluation before wiring the runtime

The benchmark has two model-context arms over the same synthetic
tool-heavy transcript:

- **Baseline:** current full tool-result prompt.
- **Candidate:** the adaptive model-only result window.

Measurements:

- exact prompt tokens reported by the active llama-server;
- projected token consumption from Forge's current estimator;
- whether the server accepts the request;
- raw-result round-trip: every omitted range must be recoverable byte-for-byte;
- task-fact recall: the excerpt must retain identifiers at the beginning and
  end of an oversized result, while the retrieval tool returns the middle.

The candidate passes only if it prevents the overflow, reduces input tokens
substantially, retains all raw data, and preserves the test's task facts and
exact range recovery.

## Regression coverage

- Pure transform: no change below budget; largest-first bounded reductions;
  protocol fields preserved; raw messages untouched.
- Retrieval: current-conversation scope, strict argument bounds, exact chunk
  reconstruction.
- Tool loop: an over-budget prepared request is never sent.
- Recovery: llama-server `exceeds the available context size` is marked
  incomplete so automatic compaction can resume safely.

## Delivery

Run the focused tests, then `npm run ci` and `npm run package`. The package
command produces the local VSIX; no installation or publish is implied.
