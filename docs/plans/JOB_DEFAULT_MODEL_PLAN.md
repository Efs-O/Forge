# Job default model + resume reschedule

## Problem

1. **No editable model for jobs.** `manage_jobs create` writes the current
   `active_model` into every `agent_task` (`pinAgentTaskModel`, 0.16.30). The
   pin was right — `active_model` follows chat-tab switches, and an unattended
   job once ran on a paid cloud model because of one — but it leaves the model
   scattered across `~/.forge/jobs/*.json`. Moving every job to another model
   means editing each file.
2. **Resume fires stale runs.** Pausing leaves `next_due_at` where it was.
   Resuming (`manage_jobs` resume, `update` with `enabled: true`, Telegram
   `resume`) keeps it, so a job paused for a week fires the moment it is
   resumed — five jobs resumed at 02:30 would all run at 02:30.

## Design

- **`jobs.default_model`** (optional string) in `config.yaml`. Written only by
  the user; nothing in Forge sets it, so a tab switch cannot move it.
- **Resolution** (one owner, `jobDefaultModel()` in `src/config/jobsSchema.ts`):
  `action.model` → `jobs.default_model` → `active_model`. The last step keeps
  today's behaviour for configs without the field.
- **Create**: with `jobs.default_model` set, `manage_jobs create` stops
  pinning — the job follows the config. Without it, the 0.16.30 pin stays.
  An explicit `model` on the action is always kept (a per-job override).
- **Validation**: not a schema refinement — a typo would refuse the whole
  config and take the chat down with it. An unknown name fails the run, and
  the runner already reports that per run (run row + delivery).
- **Resume** (one owner, `JobStore.setEnabled()`): on resume, a `next_due_at`
  that is null or already past is moved to the next scheduled time; a future
  one is kept. Missed runs while paused are not replayed. All three resume
  paths call it.

## Files

| File | Change |
|---|---|
| `src/config/jobsSchema.ts`, `src/config/types.ts` | `default_model` field; `jobDefaultModel()` |
| `src/vscode/jobsSetup.ts` | runner `defaultModel` uses `jobDefaultModel()` |
| `src/tools/jobTools.ts` | no pin when the default is set; consent check and resume use the owners |
| `src/jobs/JobStore.ts` | `setEnabled()` |
| `src/remote/RemoteJobCommands.ts` | pause/resume via `setEnabled()` |
| `docs/JOBS.md` | document the field and the resume rule |

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `jobs.default_model` in config.yaml | Hand edit only | Hand edit; absent falls back to `active_model` (pre-change behaviour) | Not pausable; removing it is the off switch | User's editor writes the file; an unparseable config is reported by the existing loader | Nothing in memory: read via `getConfig()` per run | None |
| Job definition without `model` (existing JobStore file) | `manage_jobs create` while the default is set, or a hand edit | `manage_jobs delete` (unchanged) | `enabled: false` (unchanged) | JobStore atomic write (unchanged) | Model resolved per run, so a restart picks up the current default | Job's own schedule (unchanged) |
| `next_due_at` on resume (existing state file) | `JobStore.setEnabled(true)` recomputes it when null or past | Deleted with the job (unchanged) | Pausing leaves it; the scheduler skips disabled jobs | `patchState` is a synchronous read-modify-write with an atomic write | Scheduler re-reads state each tick | Superseded by the next run's own reschedule |

CI-enforced row: `test/unit/JobStore.test.ts` asserts a resumed job with a past
`next_due_at` is moved to the future and a future one is kept.

## Acceptance criteria

- A job with no `model` runs on `jobs.default_model` when set, else on
  `active_model`; a job with a `model` runs on it regardless.
- `manage_jobs create` with the default set writes no `model`; without it, it
  pins `active_model` as before.
- Resuming via either tool path or Telegram never runs a job immediately
  because of a time that passed while it was paused.
- `npm run ci` green.
