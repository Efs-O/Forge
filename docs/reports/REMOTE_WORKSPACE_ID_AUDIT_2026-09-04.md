# Remote workspace identity implementation audit

**Date:** 2026-09-04  
**Result:** PASS after one compatibility fix  
**Plan reviewed:** `docs/plans/REMOTE_WORKSPACE_DISCOVERY_PLAN.md`

## Scope

This audit reviewed the uncommitted follow-up that made workspace handoff and
extension activation share `workspaceIdFor()`. The relevant paths were:

- `src/extension.ts`
- `src/remote/RemoteWorkspaceHandoff.ts`
- `src/remote/RemoteRuntime.ts`
- `src/remote/RemoteWorkspaceDiscovery.ts`
- `test/unit/RemoteWorkspaceHandoff.test.ts`
- the existing discovery and workspace-selection unit suites

The review checked the plan's identity invariant: an open VS Code workspace,
a discovered sibling, and an explicitly configured alias must derive the same
workspace id so current-workspace marking and durable handoff claiming work.

## Finding and resolution

### F1 — Whole-path lowercasing broke existing Windows workspace identities

**Severity:** High  
**Status:** Fixed

The implemented Windows normalization lowercased the complete resolved path.
That made differently cased aliases converge, but it also changed the hash for
every existing mixed-case workspace path. For example, the established VS Code
spelling `n:\\vs code apps\\Forge` no longer hashed to its previous id. Existing
remote bindings and pending handoffs would still refer to the old id, so an
upgrade could make them unreachable from that workspace.

The fix now:

1. asks Windows for the existing path's canonical filesystem spelling;
2. lowercases only the drive letter, matching VS Code's historical `Uri.fsPath`
   spelling; and
3. hashes that canonical value from the single shared `workspaceIdFor()` owner.

This makes arbitrary Windows case variants converge without changing the id of
an ordinarily opened existing workspace. POSIX behavior remains case-sensitive.
If a configured path has disappeared, hashing remains deterministic and the
existing workspace-open path remains responsible for reporting that setup
failure.

Regression coverage now proves both Windows case convergence and preservation
of the legacy lowercase-drive hash. The POSIX casing test remains in place.

## Plan conformance

| Requirement | Audit result |
| --- | --- |
| One workspace-id derivation shared by activation, alias matching, and handoff recording | Pass |
| Windows drive/path casing cannot prevent a handoff claim | Pass after F1 fix |
| Existing normal Windows workspace ids remain stable | Pass after F1 fix |
| POSIX path casing remains significant | Pass |
| No duplicated identity implementation remains in `extension.ts` | Pass |
| Discovery, explicit-alias precedence, numbering, and current-workspace matching remain covered | Pass |

## Verification evidence

Focused verification:

```text
npm test -- --run test/unit/RemoteWorkspaceHandoff.test.ts \
  test/unit/RemoteWorkspaceDiscovery.test.ts \
  test/unit/RemoteWorkspaceSelection.test.ts

3 test files passed
20 tests passed, 1 platform-specific test skipped
```

Canonical repository gates:

```text
npm run ci
203 test files passed, 5 skipped
1,754 tests passed, 18 skipped
type-check, lint, production build, and bundle-load check passed

npm run package
release build passed
VSIX packaged successfully: forge-llm-0.15.14.vsix
33 files, 8.27 MB
```

`git diff --check` also passed before the release gates.

## Residual risk

No blocking issue remains in the audited scope. A Windows workspace opened
through a junction or symbolic link will intentionally identify with the
filesystem target returned by `realpath`; this is the correct location identity
for handoff matching, but it can cause a one-time identity change for an older
installation that previously keyed the workspace by the link spelling. No such
configuration was observed during this audit.

The benchmark handoff document and generated Python `__pycache__` directory
were present before this audit and were not treated as part of the workspace-id
implementation.
