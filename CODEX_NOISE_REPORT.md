# Codex / Forge Console Noise Report

Date: 2026-06-02

## Applied Fixes

### Forge IPC noise

Added no-op handling for:

- `thread-stream-state-changed`
- `thread-read-state-changed`

Files changed:

- `webview-ui/src/App.tsx`
- `src/sidebar/messageBridge.ts`

Approach:

- extend the `HostToWebview` union with the two broadcast message types
- accept both in the webview switch and intentionally do nothing

This suppresses the repeated `Received broadcast but no handler is configured` warnings without affecting normal Forge chat messages.

### GitHub plugin loader noise

Removed icon declarations from these cached skill manifests:

- `skills/github/agents/openai.yaml`
- `skills/gh-fix-ci/agents/openai.yaml`
- `skills/gh-address-comments/agents/openai.yaml`
- `skills/yeet/agents/openai.yaml`

Reason:

The Codex loader was rejecting `icon_small` / `icon_large` and emitting repeated warnings about icon paths resolving outside the accepted plugin asset root.

## Scope

The Forge fix affects only the two noisy thread-state broadcast types.

It does not disable the normal app-local message types such as:

- `token`
- `reasoningToken`
- `done`
- `error`
- `ready`
- `backendStarting`
- `backendDown`
- `models`
- `checkpointReady`
- `toolActivity`
- `fileDiff`
- `sessionSync`
- `confirmRequest`
- `tokenBudget`
- `setInput`
- `clankerChanged`

## Notes

The GitHub manifest edits were applied in the global Codex plugin cache rather than inside the Forge repo, because that warning source is outside the repository.
