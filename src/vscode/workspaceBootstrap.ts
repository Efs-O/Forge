import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  discoverWorkspaceRepositoryRoots,
  ensureForgeInstructionsFile,
} from '../llm/ForgeInstructionsLoader';
import {
  NOTE_INSTALLED_MARKER,
  NOTE_OFF_NOTICE_MARKER,
  agentMeshNoteFacts,
  findWorkspaceAgentNotes,
  hasAgentNoteFile,
  installAgentMeshNote,
  refreshAgentMeshNote,
  planNoteInstall,
  hashAgentMeshNote,
  renderAgentMeshNote,
  NOTE_HASH_MARKER,
  registerAgentMeshNoteCommand,
  describeAgentMeshNoteInstall,
} from './agentMeshNoteSetup';
import { registerDesktopConnectCommands } from './desktopConnect';
import { registerDesktopShareCommands } from './desktopShare';
import { registerDesktopCheckConnectionCommands } from './desktopCheckConnection';
import { registerAgentUserNoteCommand, refreshUserNote, userNoteFacts } from './agentUserNote';
import { wireDesktopKeepingUp } from './desktopKeepingUp';
import type { ForgeConfig } from '../config/types';
import { getLogger } from '../util/logger';

/**
 * One-shot, idempotent workspace bootstrap on activation: retiring the old
 * global-session migration, the optional FORGE.md auto-create,
 * and the agent note when the mesh is on. Each runs at most once per
 * workspace; their order does not matter. The four desktop-bridge commands are
 * registered above the no-folder return, because none of them needs a folder
 * and package.json contributes all four with no `when`.
 *
 * The agent note is written here rather than by the setup agent because this
 * is the one place Forge is sure to run in the workspace the agent will later
 * read (laptop audit F9). It is written once per workspace and never again
 * unless `forge.agentMesh.installNote` is run: a user who deletes the marked
 * section has said they do not want it, and re-adding it on every start would
 * be Forge arguing with that.
 *
 * `config` is the activation-time snapshot, and it is the right thing for
 * everything this function itself does. `getConfig` is the live getter, and it
 * belongs to the desktop bridge: those commands run whenever the owner picks
 * them from the palette, long after this call returned, and `extension.ts`
 * reassigns its `config` on every config.yaml reload. Handed the value, they
 * keep a dead snapshot for the window's whole life and plan a `tailscale serve`
 * for a port the current config no longer mentions.
 */
export async function bootstrapWorkspace(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  config: ForgeConfig,
  configPath: string,
  getConfig: () => ForgeConfig,
): Promise<void> {
  const log = getLogger();
  const autoCreate = config.forge_instructions?.auto_create;
  // Retire the old import: it seeded every new project with the same global
  // chats. Keep the legacy data untouched, and the marker for older builds.
  if (!context.workspaceState.get<boolean>('forge.migrated.sessions.v2')) {
    await context.workspaceState.update('forge.migrated.sessions.v2', true);
  }
  // The desktop bridge (docs/plans/V1_FINISH_PLAN.md lane 3): "Connect to my
  // desktop" writes the entries, "Check connection" walks the same path in
  // words and names the first link that is broken, and "Share this computer"
  // and "Stop sharing" turn the desktop's two switches and its two `serve`
  // shares on and off. Registered above the no-folder return, because none of
  // the four needs a folder: they read the machine-scoped config and its path,
  // run the Tailscale CLI and make HTTP requests. package.json contributes all
  // four with no `when`, so a window with no folder open lists them in the
  // palette, and until they are registered here the owner gets "command not
  // found" from a command the extension says it provides. Registered in this
  // module rather than in `extension.ts`, which is at its 500-line cap and
  // already calls this with the context, the config, its path and the live getter.
  const desktopDeps = { getConfig, getConfigPath: () => configPath };
  registerDesktopConnectCommands(context, desktopDeps);
  registerDesktopShareCommands(context, desktopDeps);
  registerDesktopCheckConnectionCommands(context, desktopDeps);
  // `Forge: Add Agent Note to My User Files` writes the user-wide copy of the
  // agent note into `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`. Registered
  // here, above the no-folder return, for the same reason as the four desktop
  // commands: neither the command nor the files it writes belong to a workspace,
  // so a window with no folder open must still offer it. `agentMeshNoteFacts`
  // owns how a path is spelled inside a note, so the bus folder comes from it.
  registerAgentUserNoteCommand(context, {
    getBusDir: () => agentMeshNoteFacts(getConfig(), configPath).busDir,
  });
  if (!workspaceRoot) return;
  const meshOn = config.agent_bus?.enabled === true;
  const repositoryRoots =
    autoCreate || meshOn || context.workspaceState.get(NOTE_INSTALLED_MARKER)
      ? await discoverWorkspaceRepositoryRoots(workspaceRoot)
      : [];

  if (autoCreate) {
    for (const repositoryRoot of repositoryRoots) {
      const bootstrap = ensureForgeInstructionsFile(repositoryRoot);
      if (bootstrap.status === 'error') {
        const message = `Forge: could not create ${path.basename(bootstrap.path)} in ${repositoryRoot} — ${bootstrap.error.message}`;
        log.warn(message);
        void vscode.window.showWarningMessage(message);
      }
    }
  }

  registerAgentMeshNoteCommand(context, {
    // The same reason as the desktop bridge above: this is a palette command, so
    // it runs long after this call returned, and the note it renders describes
    // the config as it stands now, not the one activation was handed.
    getConfig,
    getConfigPath: () => configPath,
  });
  // The keeping-up notice stays behind the no-folder return: it is not a palette
  // command, and in a window with no folder it would dial the desktop at
  // activation and offer to write the machine config with nobody having asked.
  wireDesktopKeepingUp(context, desktopDeps);
  const noteFacts = agentMeshNoteFacts(config, configPath);
  const noteHash = hashAgentMeshNote(renderAgentMeshNote(noteFacts));
  const noteAction = planNoteInstall(
    context.workspaceState.get(NOTE_INSTALLED_MARKER) === true,
    context.workspaceState.get<string>(NOTE_HASH_MARKER),
    noteHash,
    // The marker survives an uninstall, so it is only trusted while a note file
    // is actually here to refresh (see `planNoteInstall`).
    hasAgentNoteFile(repositoryRoots),
  );
  // The user-wide copy of the note, refreshed where its markers already are
  // (see `src/vscode/agentUserNote.ts` for why nothing here ever creates those
  // files). Failures are a log line, not a toast: a machine whose owner never
  // ran the command has no `~/.claude` to write, and that is not a problem to
  // be told about on every start.
  if (meshOn) {
    const userResults = refreshUserNote(os.homedir(), userNoteFacts(noteFacts.busDir));
    const refreshed = userResults.filter((result) => result.status === 'replaced');
    if (refreshed.length) log.info(describeAgentMeshNoteInstall(refreshed));
    for (const failure of userResults.filter((result) => result.status === 'error')) {
      log.warn(`user agent note: ${failure.path} — ${failure.reason}`);
    }
  }
  if (meshOn && noteAction !== 'none') {
    // A first install may create a file or append a section; a refresh only
    // replaces a section that is already there, so an owner who deleted it keeps
    // it deleted (phase B row C9, criterion 8b).
    const results =
      noteAction === 'install'
        ? installAgentMeshNote(repositoryRoots, noteFacts)
        : refreshAgentMeshNote(repositoryRoots, noteFacts);
    const failures = results.filter((r) => r.status === 'error');
    for (const failure of failures) log.warn(`agent note: ${failure.path} — ${failure.reason}`);
    // Only mark it done when something was actually written or found: an all-
    // error run (a read-only share, a locked file) must be retried next start
    // rather than silently never happen again. The hash is stored after the
    // writes, so a crash between the two leaves the old hash and the refresh
    // repeats next start — the same text, so repeating it costs nothing.
    if (results.some((r) => r.status !== 'error')) {
      await context.workspaceState.update(NOTE_INSTALLED_MARKER, true);
      await context.workspaceState.update(NOTE_HASH_MARKER, noteHash);
      const message = describeAgentMeshNoteInstall(results);
      log.info(message);
      if (results.some((r) => r.status === 'created' || r.status === 'appended')) {
        // F9 point 6: the trust change is disclosed once, in plain words, not
        // buried in a file the user may never open.
        const written = results.find((r) => r.status === 'created' || r.status === 'appended');
        // Shown, never awaited. This runs inside `activate()`, and by now the
        // control server has bound its port and published `endpoint.json`, so
        // the mesh can already reach this window — but the step that hands the
        // control server and the job tools their sidebar provider is below this
        // function. Holding activation open for a toast made an unattended
        // window answer every `forge.sh` call with "Cannot read properties of
        // undefined (reading 'getHostFacade')" until somebody dismissed the
        // popup: a window nobody was looking at was a window nobody could use.
        // The toast still stays up, "Open the file" still opens it, and a
        // failure to open is reported to the owner rather than logged and lost.
        void Promise.resolve(
          vscode.window.showInformationMessage(
            `${message} Local coding agents (Claude Code, Codex, Copilot) can now message, steer and stop Forge chats.`,
            'Open the file',
          ),
        )
          .then(async (picked) => {
            if (picked !== 'Open the file' || !written) return;
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(written.path));
            await vscode.window.showTextDocument(document);
          })
          .catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            // Nothing awaits this promise, so a failure that only reached the
            // log would never be seen — the toast is gone by the time the open
            // fails, and the note the owner is being told about is not.
            log.warn(`agent note: could not open the written note — ${reason}`);
            void vscode.window.showWarningMessage(
              `Forge wrote the agent note but could not open it (${
                written ? path.basename(written.path) : 'no file reported'
              }): ${reason}`,
            );
          });
      }
    }
    if (failures.length) {
      // A note that silently failed to land is the F9 problem again, so say so
      // and name the way to retry it, rather than only writing to the log.
      void vscode.window.showWarningMessage(
        `Forge could not write the agent note into ${failures.map((f) => `${path.basename(f.path)} (${f.reason})`).join('; ')}. Run "Forge: Set Up Agent Note" to try again.`,
      );
    }
  } else if (!meshOn && repositoryRoots.length) {
    const held = findWorkspaceAgentNotes(repositoryRoots);
    if (held.length && !context.workspaceState.get(NOTE_OFF_NOTICE_MARKER)) {
      await context.workspaceState.update(NOTE_OFF_NOTICE_MARKER, true);
      const message =
        `The agent mesh is off, so agents cannot message this workspace's Forge chats. ` +
        `The note Forge left in ${held.map((p) => path.basename(p)).join(', ')} can be deleted ` +
        `(everything between the two forge-agent-mesh comment lines).`;
      log.info(message);
      void vscode.window.showInformationMessage(message);
    }
  }
}
