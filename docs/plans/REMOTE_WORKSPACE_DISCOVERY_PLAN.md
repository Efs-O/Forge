# Remote Workspace Discovery Plan

**Date:** 2026-09-01
**Status:** approved in conversation, blocked on REMOTE_SELECTION_PAGINATION_PLAN
**Scope:** make `/workspace list` find the user's other projects with no
configuration, and let `/new <n>` switch to one by number.

## Problem

Telegram is served by exactly one VS Code window — whichever won the `telegram`
lease in `<globalStorage>/remote-leases/telegram.lease.json`. Every prompt lands
in that window's workspace regardless of which window the user is looking at.
The only escape is `/new <alias>`, and aliases must be hand-written into
`remote.workspace_aliases` in `config.yaml`. In practice that block is empty, so
`/workspace list` answers "no remote workspace aliases are configured" and the
feature is unreachable.

Two constraints shape the fix:

- A hardcoded projects directory is a CLAUDE.md hard stop.
- Asking a new user to hand-write four path/display pairs before the feature
  does anything is why the existing block is empty.

## Approach

Derive the search root instead of configuring it:

    path.dirname(workspaceFolders[0])

For a window opened on `N:\vs code apps\Forge` that is `N:\vs code apps`; for
`~/dev/thing` it is `~/dev`. Correct for every user, hardcoded for none, and
right on first run with an empty config.

List its immediate subdirectories. That is the entire rule.

### No `.git` filter

Filtering to git repositories was the obvious refinement and it is wrong. On the
originating user's disk the parent holds 29 directories, 13 of them repos — and
`Qwen testing`, the folder whose absence started this whole investigation, is
**not** a repo. A filter that hides the motivating case is not a refinement.

Excluded instead: dotfolders, `node_modules`, and anything unreadable. Cap the
scan at 100 entries so a user whose project sits directly in their home
directory gets a bounded list rather than a hang.

### No new configuration

No `enabled` flag, no `roots` array, no `max`. Discovery is the default
behaviour of `/workspace list`.

`remote.workspace_aliases` keeps its current meaning and wins on collision: it
is how a user pins a display name, or reaches a project that does not live
beside the current one. An explicit alias whose path matches a discovered
directory replaces it rather than duplicating it.

This is deliberately *not* the "prefer explicit config over hidden fallback"
case that CLAUDE.md warns about. Nothing is being masked: the list shows real
directories, names them by their real basenames, and the switch opens the real
path. There is no invalid state for a flag to hide.

### Freshness

Scan when `/workspace list` runs, not at startup. A project created after the
window opened then appears without a reload, and the cost is one `readdir` per
invocation.

## Numbering

`workspaces` becomes a third selection kind beside `conversations` and `models`,
so the pager already being built for `/list` and `/models` supplies numbering,
absolute page-spanning indices, the ten-minute TTL, and the inline keyboard.
29 entries is three pages; `/new 14` switches to entry 14.

This is why the work is blocked rather than merely queued: it is a reuse of
`RemoteSelectionPager`, and that file is mid-implementation.

## Work already written

`scratchpad/telegram-workspace-selection.patch` (verified `git apply --check`
clean at 14:15) carries the numbering half of this plan:

- `types.ts`, `RemoteStoreSchemas.ts` — add `'workspaces'` to the two enums
- `RemoteSelectionPager.ts` — `sendWorkspaceSelection`, `formatWorkspaces`,
  marking the current workspace ` · current`
- `RemoteCommandHandler.ts` — `/workspace list [page]`, `/new <n-or-alias>`,
  and a rejection when `/new` targets the workspace the chat is already in
- `RemoteController.ts` — threads `currentWorkspaceAlias` to both context sites
- `RemoteRuntime.ts` — derives `currentWorkspaceAlias` by hashing each alias
  path exactly as `extension.ts` derives `workspaceId`
- `RemoteSessionCommands.ts` — help text

It was backed out of the working tree because a concurrent session is
implementing the pagination plan in the same files.

## Remaining work

1. Apply the patch once the pagination work lands.
2. Add the discovery scan — new module, owner row in `docs/OWNERS.md`, merged
   under the explicit aliases in `RemoteRuntime.controllerOptions`.
3. Unit tests: discovery excludes dotfolders and `node_modules`; explicit
   aliases override a discovered directory at the same path; the cap holds;
   `/new <n>` resolves through the selection and `/new <alias>` still works.
4. `npm run ci` green — never yet achieved for this change, because the tree was
   mid-edit by the other session every time it was run.

## Open question

Discovery assumes the parent of the workspace root is a projects folder. It is
for the originating user and for the common `~/dev/<project>` layout. For a
project opened directly from a home or drive root the list will be noise the
user must ignore — bounded and harmless, but not useful. Revisit only if that
turns up in practice; guessing at it now would reintroduce exactly the
configuration surface this plan removes.
