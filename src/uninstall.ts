/**
 * The `vscode:uninstall` entry point (`package.json` → `node ./dist/uninstall.js`).
 *
 * VS Code runs it after the extension folder is already gone — on the next
 * start, whenever that happens — so there is no extension host here and no
 * `vscode` API to import: the uninstall build bundles with `external: []`
 * precisely so that an accidental `vscode` import fails the build instead of
 * failing the uninstall on the owner's machine.
 *
 * This is the only place Forge removes the user-wide copies of the agent note
 * (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`). A workspace start cannot do
 * it: another workspace on the machine may still have `agent_bus` on, and its
 * note is the same file. Uninstalling is the one event that says no workspace
 * is listening any more, so the removal of everything the registry names —
 * every workspace's `AGENTS.md` / `CLAUDE.md` still holding the section, and
 * both user files — happens here and nowhere else.
 */

import * as os from 'os';
import {
  noteFilesRegistryPath,
  removeRecordedAgentNotes,
  type NoteRemovalResult,
} from './agentBus/agentNoteRemoval';

/** Remove the note from every file the registry under `home` names. Exported so
 *  a test can point it at a temporary home instead of the operator's own. */
export function runUninstall(home: string): NoteRemovalResult[] {
  return removeRecordedAgentNotes(noteFilesRegistryPath(home));
}

if (require.main === module) {
  // An uninstall runs with nobody watching: whatever happens, the removals that
  // did happen are reported and the process still says it finished.
  try {
    for (const result of runUninstall(os.homedir())) {
      console.log(`${result.status} ${result.path}${result.reason ? `: ${result.reason}` : ''}`);
    }
  } catch (error) {
    console.error(`agent note uninstall cleanup failed: ${(error as Error).message}`);
  }
  process.exitCode = 0;
}
