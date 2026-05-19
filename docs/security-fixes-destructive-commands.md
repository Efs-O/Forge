# Security Fix Report — Destructive Command Guardrails

**Date:** 2026-05-18  
**Branch:** main  
**Files changed:** `src/tools/DenyList.ts`, `src/tools/fileEditTools.ts`, `src/sidebar/ToolDispatch.ts`

---

## Background

Forge agents can execute terminal commands, edit files, and delete directories.
The original code had three gaps that could allow destructive actions to slip
through with insufficient (or misleading) confirmation dialogs:

1. Denylist regexes had blind spots for common flag-splitting tricks
2. File/delete tools accepted absolute paths outside the workspace with no extra warning
3. `delete_file { recursive: true }` showed the same plain "Allow" dialog as
   a harmless read — no "DANGEROUS" escalation

The principle we're following (same as Claude Code): **agents propose, humans
dispose**. Nothing is hard-blocked except workspace escape — every destructive
command is still executable, but the user sees an unambiguous warning.

---

## What Was Fixed

### 1. Denylist regex gaps — `src/tools/DenyList.ts`

| Gap | Old pattern | Fix |
|-----|-------------|-----|
| `rm -r -f` (split flags) | `/rm\s+-[rR][fF]?[\s\/~]/` | `/\brm\b.*-[rR].*-[fF]/` — order-agnostic |
| `Remove-Item -Force -Recurse` (reversed order) | `Remove-Item.*-Recurse.*-Force` | Two separate patterns cover both orderings |
| `git push --force-with-lease` | not present | Added |
| `git reset` (any variant) | only `--hard` | Now covers `--hard`, `--mixed`, `--soft` |

### 2. Workspace path confinement — `src/tools/fileEditTools.ts`

Added `guardWorkspacePath()`: throws a hard error if a resolved path escapes
the workspace root. Applies to:

- `replace_in_file`
- `create_directory`
- `move_file` (both source and destination)
- `delete_file`

An agent can no longer target `C:\Windows\System32` or `~/.ssh` even if the
user clicks "Allow" — the check fires before the approval dialog. If a user
genuinely needs to operate outside the workspace they use the terminal
themselves.

### 3. Dangerous escalation for recursive delete — `src/sidebar/ToolDispatch.ts`

`requestApproval` now accepts an `isDangerous` boolean. When
`delete_file` is called with `recursive: true`, the approval dialog switches
from the plain "Forge wants to run" style to the red
**"⚠️ DANGEROUS — Run (I understand the risk)"** modal, the same treatment
given to denylist-matched shell commands.

---

## What Was NOT Changed

- Agents can still delete files, run commands, push git commits — subject to
  user confirmation. Nothing was hard-blocked beyond workspace escape.
- `run_terminal` behavior is unchanged (paste-only, user presses Enter).
- Permission tiers (`read / write / delete / terminal / git`) are unchanged.
- No new dependencies added.

---

## Testing

```bash
npx tsc --noEmit          # type-check passes
npm run package           # bundle smoke-test
```

Manual scenarios to verify:
- `delete_file { path: "src/foo.ts" }` → plain "Allow" dialog
- `delete_file { path: "src/foo", recursive: true }` → red DANGEROUS dialog
- `delete_file { path: "C:\\Windows\\System32" }` → throws before dialog
- `exec_command rm -rf /` → denylist hit → red DANGEROUS dialog (still approvable)
- `exec_command rm -r -f /` → now also caught by updated regex
