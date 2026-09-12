# Deferred agent workflow checks

Status: **deferred.** This note records small automated checks to add later; it
does not change the current build or agent workflow.

## Proposed checks

- Verify that `package.json.version` has a matching release heading in
  `CHANGES.md` whenever the package version changes.
- Verify that every plan marked `implemented` has an `Acceptance criteria`
  checklist and no unchecked required item.
- Verify the repository's source-file line limit using the same rule as ESLint,
  while keeping the 350-line target as advisory guidance.
- Make the final validation command report type-check, lint, tests, build,
  bundle, packaging, `git diff --check`, and untracked files in one summary.

## Acceptance criteria

- A missing changelog heading fails with the package version and expected file.
- An implemented plan with stale or unchecked acceptance criteria is reported.
- The line-count check agrees with the configured lint boundary.
- The checks are opt-in until their false-positive behavior is verified.
