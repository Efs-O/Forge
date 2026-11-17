import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildAgentMeshNote, type AgentMeshNoteFacts } from '../agentBus/agentMeshNote';
import {
  describeAgentMeshNoteInstall,
  installIntoOneFile,
  refreshIntoOneFile,
  type AgentMeshNoteFileResult,
} from './agentMeshNoteSetup';

/**
 * The user-wide copy of the agent note: the same marked section, in the two
 * places a coding agent reads before any workspace is in play — `~/.claude/
 * CLAUDE.md` for Claude Code and `~/.codex/AGENTS.md` for Codex.
 *
 * Why it exists: the workspace note only reaches an agent that opens a Forge
 * workspace. A Claude Code or Codex session started somewhere else (a scratch
 * folder, a home directory, a clone Forge never bootstrapped) never sees it and
 * so never learns it can message, steer or stop a Forge chat. Both files get
 * the section — they are two different agents' user files, so the `@AGENTS.md`
 * import trick that keeps a workspace's `CLAUDE.md` from holding the text twice
 * has nothing to do here.
 *
 * The text is workspace-neutral: it cannot name one workspace's config file or
 * mesh state, because it is read in all of them, so those two facts are fixed
 * strings (`userNoteFacts`) and the note says where to look instead.
 *
 * It is a command, never an automatic write, and it has no control-server route
 * and no `forge.sh` verb on purpose: a bus token is a thing an agent already
 * holds, and letting it put lasting instructions into the owner's own files is
 * a privilege the mesh was never given. The only automatic write here is the
 * refresh on a start, and that replaces text only where the markers already are
 * — running Forge is not consent to write into a home folder.
 */

/** `Forge: Add Agent Note to My User Files`. */
export const USER_NOTE_COMMAND = 'forge.agentMesh.installUserNote';

/** The two user-wide instruction files, one per agent CLI, under `homeDir`.
 *  `homeDir` is a parameter rather than `os.homedir()` so the tests can pass a
 *  temporary folder and never touch the operator's own files. */
export function userNoteFiles(homeDir: string): string[] {
  return [path.join(homeDir, '.claude', 'CLAUDE.md'), path.join(homeDir, '.codex', 'AGENTS.md')];
}

/**
 * The facts for the user-wide copy. `busDir` is the real, machine-wide agent-bus
 * folder, spelled exactly as the workspace copy spells it; the two facts a
 * workspace note answers for itself are fixed here, because this copy is not in
 * any workspace and cannot say what one's config holds.
 */
export function userNoteFacts(busDir: string): AgentMeshNoteFacts {
  return {
    busDir,
    // The template already wraps this token in one pair of backticks, so the
    // value carries only the second pair: the line reads
    // Config: `<workspace>/.forge/config.yaml`, else `~/.forge/config.yaml`.
    configPath: '<workspace>/.forge/config.yaml`, else `~/.forge/config.yaml',
    meshState:
      "this is the user-wide copy; each workspace's own note records that workspace's settings.",
  };
}

/** `mkdir -p`, with the reason it failed instead of the throw. */
function ensureFolder(folder: string): string | undefined {
  try {
    fs.mkdirSync(folder, { recursive: true });
    return undefined;
  } catch (err) {
    return `could not create ${folder}: ${(err as Error).message}`;
  }
}

/**
 * Write the section into both user files, creating each file (and its folder)
 * when missing and adding beside whatever the owner already had in them. The
 * symlink and regular-file checks are the workspace note's (`installIntoOneFile`):
 * a `~/.claude/CLAUDE.md` that is a link to a file the owner keeps elsewhere is
 * reported, not replaced by a regular file.
 */
export function installUserNote(
  homeDir: string,
  facts: AgentMeshNoteFacts,
): AgentMeshNoteFileResult[] {
  const note = buildAgentMeshNote(facts);
  return userNoteFiles(homeDir).map((filePath) => {
    const failed = ensureFolder(path.dirname(filePath));
    if (failed) return { path: filePath, status: 'error', reason: failed };
    return installIntoOneFile(filePath, note);
  });
}

/**
 * On a start: replace the section in each user file that already holds one.
 *
 * A file that is missing, or that holds no complete marked section, is never
 * created and never appended to — the owner ran the command once, or they did
 * not, and a start is not the moment to change their mind for them.
 */
export function refreshUserNote(
  homeDir: string,
  facts: AgentMeshNoteFacts,
): AgentMeshNoteFileResult[] {
  const note = buildAgentMeshNote(facts);
  return userNoteFiles(homeDir).map((filePath) => refreshIntoOneFile(filePath, note));
}

export interface AgentUserNoteCommandDeps {
  /** The agent-bus folder as the note should spell it. `agentMeshNoteFacts`
   *  owns that spelling (forward slashes on Windows), so the caller hands the
   *  value down rather than this module rebuilding it. */
  getBusDir: () => string;
}

/** `Forge: Add Agent Note to My User Files`: the user-wide install, on demand.
 *  Needs no folder, so it is registered above `bootstrapWorkspace`'s no-folder
 *  return, like the desktop-bridge commands. */
export function registerAgentUserNoteCommand(
  context: vscode.ExtensionContext,
  deps: AgentUserNoteCommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(USER_NOTE_COMMAND, async () => {
      const results = installUserNote(os.homedir(), userNoteFacts(deps.getBusDir()));
      const message = `${describeAgentMeshNoteInstall(results)} Files: ${results
        .map(
          (result) =>
            `${result.path} (${result.status}${result.reason ? `: ${result.reason}` : ''})`,
        )
        .join('; ')}.`;
      if (results.some((result) => result.status === 'error')) {
        void vscode.window.showWarningMessage(message);
      } else {
        void vscode.window.showInformationMessage(message);
      }
    }),
  );
}
