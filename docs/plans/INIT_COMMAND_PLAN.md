# `/init`: let the agent fill in FORGE.md

## Why

`/initForge` asks the model once, with no tools, to write a whole `FORGE.md`
from a shallow folder scan, and overwrites the existing file after a prompt.
The model cannot run a command or open a file, so what it writes about
commands and layout is a guess. OpenCode's `/init` is a normal agent turn that
reads the repo and writes the file. A user comparing the two would rightly say
ours is the weaker one, and a guessed "Test: npm test" costs the agent a
failed round later.

## Design

- `/init` is the trigger users know; `/initForge` stays as a second trigger
  for the same command id `initForge`, so nothing that already sends it breaks.
- The command makes sure the file exists (`ensureForgeInstructionsFile`, which
  never replaces user content) and then starts an ordinary agent turn
  (`deps.submitPrompt`) with the init prompt. The turn has the agent's usual
  tools, and every edit goes through the usual confirmation gate and per-turn
  checkpoint, so `/undo` reverts it.
- The prompt asks the agent to fill the starter's blank sections
  (Project facts, Commands, Full gate), to run each command it writes down
  before writing it, to keep only facts that save a future session a round,
  to keep the starter's working rules, never to delete or rewrite content a
  person wrote, and to keep the file around 4 KB.
- The no-tools path (`collectWorkspaceContext`, `extractMarkdownFromToolCall`)
  is removed; nothing else calls it.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash mid-write | Owner-process death | TTL/expiry |
|---|---|---|---|---|---|---|
| `FORGE.md` in the repository root | `ensureForgeInstructionsFile` (exclusive create, starter content), then the agent's own edit tools | By the user only; `/undo` reverts the turn's edits from the checkpoint | Not running `/init`; a cancelled turn stops further edits | The starter write is one `wx` write; agent edits use the existing atomic write path and checkpoint | The turn dies like any turn; the checkpoint still allows `/undo` | None: the file is kept until the user changes it |

CI-enforced row: `initForgeCommand.test.ts` asserts that `/init` on a folder
with an existing `FORGE.md` leaves its bytes unchanged before the turn starts,
and that the command submits a turn rather than writing the file itself.

## Acceptance criteria

- `/init` and `/initForge` both appear in the slash menu and run the same
  command.
- On a folder with no `FORGE.md`, the starter is created and an agent turn
  starts with the init prompt.
- On a folder with a `FORGE.md`, its content is untouched by the command
  itself, no overwrite prompt is shown, and the turn is told to keep what a
  person wrote.
- With no workspace folder, the command warns and starts no turn.
- `npm run ci` and `npm run package` pass.
