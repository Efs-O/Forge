# Remote Workspace Discovery Plan

**Date:** 2026-09-01
**Status:** implemented 2026-09-01
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

### Freshness — built eagerly, not per invocation

The plan called for scanning on each `/workspace list`. Implementation showed
the price: `RemoteControllerOptions.workspaceAliases` would have to become a
callback, and roughly a dozen controller fixtures across three test files omit
that option entirely, so every one would need touching — for a refresh nobody
had asked for.

The scan runs in `controllerOptions`, which re-runs on every config change. A
sibling project created after this window opened therefore appears after a
config edit or a window reload, not instantly. That is the accepted trade.

## Numbering

`workspaces` becomes a third selection kind beside `conversations` and `models`,
so the pager already being built for `/list` and `/models` supplies numbering,
absolute page-spanning indices, the ten-minute TTL, and the inline keyboard.
29 entries is three pages; `/new 14` switches to entry 14.

Reusing `RemoteSelectionPager` rather than writing a second list renderer is
what made this cheap: no pagination logic was written for workspaces at all.

## Implementation

- `src/remote/RemoteWorkspaceDiscovery.ts` — the scan and the merge.
- `RemoteRuntime.workspaceAliases(config)` is now the single resolver, used by
  both `controllerOptions` and `handoff`, so a discovered alias is switchable
  and not merely listable.
- `test/unit/RemoteWorkspaceDiscovery.test.ts` — 8 cases.

## Numbering work, already landed

The numbering half of this plan:

- `types.ts`, `RemoteStoreSchemas.ts` — add `'workspaces'` to the two enums
- `RemoteSelectionPager.ts` — `sendWorkspaceSelection`, `formatWorkspaces`,
  marking the current workspace ` · current`
- `RemoteCommandHandler.ts` — `/workspace list [page]`, `/new <n-or-alias>`,
  and a rejection when `/new` targets the workspace the chat is already in
- `RemoteController.ts` — threads `currentWorkspaceAlias` to both context sites
- `RemoteRuntime.ts` — derives `currentWorkspaceAlias` by hashing each alias
  path exactly as `extension.ts` derives `workspaceId`
- `RemoteSessionCommands.ts` — help text

Landed in `61fa4e8`, along with two bugs review caught in it: the Telegram
callback codec stamped workspace keyboards `m`, and the controller passed
`currentWorkspaceAlias` to only one of its two context sites.

## Open question

Discovery assumes the parent of the workspace root is a projects folder. It is
for the originating user and for the common `~/dev/<project>` layout. For a
project opened directly from a home or drive root the list will be noise the
user must ignore — bounded and harmless, but not useful. Revisit only if that
turns up in practice; guessing at it now would reintroduce exactly the
configuration surface this plan removes.
