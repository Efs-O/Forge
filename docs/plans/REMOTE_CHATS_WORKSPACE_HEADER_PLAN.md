# Remote /chats workspace header

## Problem

`/chats` (and its alias `/list`) lists conversations in the current workspace but never says which workspace it is. A user who has switched between workspaces with `/workspace <n>` has no way to confirm where they are without running `/workspace` separately.

## Solution

Extend the existing `here` variable in `renderPage` (which already appends "You are in: …" to `/workspace` pages) to also fire for `conversations` pages. The `currentWorkspaceName` is already in `RemoteSelectionContext` — it is simply not used for this kind today.

The markup path (`withSelectionMarkup`) already handles the "You are in:" prefix, so no markup changes are needed.

## Change

**File:** `src/remote/RemoteSelectionPager.ts`

In `renderPage`, widen the `here` condition from:

```ts
const here =
  kind === 'workspaces' && context.currentWorkspaceName
    ? `\n\nYou are in: ${clip(context.currentWorkspaceName, 180)}`
    : '';
```

to:

```ts
const here =
  (kind === 'workspaces' || kind === 'conversations') && context.currentWorkspaceName
    ? `\n\nYou are in: ${clip(context.currentWorkspaceName, 180)}`
    : '';
```

**File:** `test/unit/RemoteSelectionPager.test.ts`

Add a test that asserts the conversation page contains "You are in: <workspace>" when `currentWorkspaceName` is set, and does not contain it when it is unset.

## Acceptance criteria

- [x] `/chats` output includes "You are in: <name>" when `currentWorkspaceName` is set — verified by new unit test.
- [x] `/chats` output does not include the line when `currentWorkspaceName` is undefined — verified by existing test (context has no `currentWorkspaceName`).
- [x] `/workspace` output is unchanged — the existing test asserting "You are in: Forge" still passes.
- [x] `/models` output is unchanged — the `here` condition does not include `models`.
- [x] HTML markup path bolds "You are in:" label the same way as before — `withSelectionMarkup` already handles this line; no change needed.
- [x] `npm test` passes.
