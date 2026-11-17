import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createHash } from 'crypto';
import {
  AGENTS_MD_IMPORT_FILE_CONTENT,
  AGENT_INSTRUCTION_FILE_NAMES,
  agentNoteTargetFiles,
  applyAgentMeshNote,
  buildAgentMeshNote,
  countAgentMeshSections,
  hasAgentsMdImportLine,
  type AgentMeshNoteFacts,
} from '../agentBus/agentMeshNote';
import { busPaths } from '../agentBus/agentBus';
import { discoverWorkspaceRepositoryRoots } from '../llm/ForgeInstructionsLoader';
import type { ForgeConfig } from '../config/types';
import { writeFileAtomicSync } from '../util/atomicWrite';

/**
 * The workspace side of the agent note (laptop audit F9 point 3): which files
 * get the marked section, the one-time disclosure, and the command that re-runs
 * the install. The section itself and its writer live in
 * `src/agentBus/agentMeshNote.ts`.
 *
 * The trigger is Forge, not the setup agent: `bootstrapWorkspace` writes the
 * section on the first start in a workspace whose mesh is on, and the same
 * writer is exposed as `forge.agentMesh.installNote` for a later run — after
 * the mesh is turned on, after the user deleted the section, or to refresh the
 * state line. An outside agent following `AI_SETUP.md` verifies the section
 * instead of writing it: the three guarantees (created when absent, added
 * beside existing text, never duplicated) are what code can test, and a fresh
 * install that never runs the AI setup still gets the note.
 */

/** Re-runs the install on demand. Registered from `workspaceBootstrap.ts`,
 *  which is where the config is already in hand. */
export const AGENT_NOTE_COMMAND = 'forge.agentMesh.installNote';

/** workspaceState markers. `.v1` so a changed rule starts fresh rather than
 *  inheriting a decision made under an older one. */
export const NOTE_INSTALLED_MARKER = 'forge.agentMesh.noteInstalled.v1';
/** The mesh-off notice: shown once per workspace, not once per start. */
export const NOTE_OFF_NOTICE_MARKER = 'forge.agentMesh.noteOffNotice.v1';
/** The hash of the note this workspace was last given (phase B row C9 of
 *  `docs/plans/AGENT_DOCS_GAP_AUDIT_PLAN.md`). It is what makes a template
 *  change reach a workspace that already has a note: the install runs once per
 *  workspace, so without it the note is forever the version the first start
 *  wrote. Stored only after the writes, so a crash leaves the old hash and the
 *  refresh repeats with the same text. */
export const NOTE_HASH_MARKER = 'forge.agentMesh.noteHash.v1';

/** The note exactly as this window would write it, so the hash and the write
 *  cannot disagree: `installAgentMeshNote` and `refreshAgentMeshNote` build it
 *  from the same facts through this same function. */
export function renderAgentMeshNote(facts: AgentMeshNoteFacts): string {
  return buildAgentMeshNote(facts);
}

/** sha256 of the rendered note, markers included. Compared, never shown. */
export function hashAgentMeshNote(note: string): string {
  return createHash('sha256').update(note, 'utf8').digest('hex');
}

/**
 * What this start should do about the workspace note (criterion 8).
 *
 * A first install is unchanged. After that the note is refreshed, and only
 * refreshed, when its rendered text differs from what was recorded.
 * `recordedHash === undefined` means the workspace got its note before this
 * hash existed: treat that note as stale, so the first start on a build that
 * carries the hash refreshes it once and records the hash.
 *
 * `noteFileExists` says whether any repository root still holds an `AGENTS.md`
 * or a `CLAUDE.md`. It is the reinstall guard: VS Code keeps `workspaceState`
 * through an uninstall, so on a laptop where Forge was removed and its files
 * deleted the marker still reads `true` while no note file is on disk. The
 * marker alone does not prove a note is still in this workspace, so a plan of
 * `refresh` there replaces a section that is not there and writes nothing.
 * A file that exists with only its marked section deleted still answers
 * `refresh`, which is how a deliberate deletion stays deleted.
 */
export function planNoteInstall(
  recordedInstalled: boolean,
  recordedHash: string | undefined,
  currentHash: string,
  noteFileExists: boolean,
): 'install' | 'refresh' | 'none' {
  if (recordedInstalled && !noteFileExists) return 'install';
  if (!recordedInstalled) return 'install';
  if (recordedHash === undefined) return 'refresh';
  return recordedHash === currentHash ? 'none' : 'refresh';
}

/** Does any of these roots still hold one of the instruction files the note
 *  goes into? A plain existence check: the writer re-reads each file for
 *  itself, so symlinks and unreadable files are settled there, not here. */
export function hasAgentNoteFile(roots: readonly string[]): boolean {
  return roots.some((root) =>
    AGENT_INSTRUCTION_FILE_NAMES.some((name) => fs.existsSync(path.join(root, name))),
  );
}

/** What one file ended up doing. `skipped` and `error` carry the reason. */
export interface AgentMeshNoteFileResult {
  path: string;
  status: 'created' | 'appended' | 'replaced' | 'unchanged' | 'skipped' | 'error';
  reason?: string;
}

/** One line stating what is enabled, as the note should record it (F6: the
 *  note has to say what is on, and writing the note must not enable anything).
 *  Paths are shown with `/` even on Windows: a code span that mixes `\` and
 *  `/` (a joined folder plus a template-appended `/README.md`) is two spellings
 *  of one path, and an agent copying it has to guess which one its shell takes.
 *  `/` is accepted by bash, PowerShell and the Node APIs alike. */
export function agentMeshNoteFacts(config: ForgeConfig, configPath: string): AgentMeshNoteFacts {
  const show = (value: string): string => value.replaceAll('\\', '/');
  const control = config.control_server;
  const bus = config.agent_bus;
  const delegate = config.permissions?.agents?.delegate;
  const state = [
    `control server ${control?.enabled ? `on, port ${control?.port ?? 8799} (loopback only)` : 'off'}`,
    `agent bus ${bus?.enabled ? 'on' : 'off'}`,
    `delegation to local agents ${delegate ? 'on' : 'off'}`,
    `Claude CLI \`${bus?.claude_cli ?? 'claude'}\`, Codex CLI \`${bus?.codex_cli ?? 'codex'}\``,
  ].join('; ');
  return {
    busDir: show(busPaths().root),
    configPath: show(configPath),
    meshState: state,
  };
}

/** Reads one instruction file, telling absence apart from a symlink and from a
 *  failed read. A symlink is skipped rather than written through: an atomic
 *  write replaces the link with a regular file, which would silently break a
 *  repository that keeps one `AGENTS.md` and symlinks `CLAUDE.md` to it. */
function readInstructionFile(filePath: string): {
  content?: string;
  absent?: boolean;
  skipped?: string;
  error?: string;
} {
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      return { skipped: 'a symlink; Forge will not turn it into a regular file' };
    }
    if (!stats.isFile()) return { skipped: 'not a regular file' };
    return { content: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { absent: true };
    return { error: `${code ?? 'read failed'}: ${(err as Error).message}` };
  }
}

/** Writes the section into one file, leaving everything outside it alone.
 *  Exported for `src/vscode/agentUserNote.ts`, which writes the same section
 *  into the user's own files through the same symlink and atomic-write rules. */
export function installIntoOneFile(filePath: string, note: string): AgentMeshNoteFileResult {
  const read = readInstructionFile(filePath);
  if (read.skipped) return { path: filePath, status: 'skipped', reason: read.skipped };
  if (read.error) return { path: filePath, status: 'error', reason: read.error };
  const applied = applyAgentMeshNote(read.content, note);
  if (applied.status === 'unchanged') return { path: filePath, status: 'unchanged' };
  try {
    writeFileAtomicSync(filePath, applied.content);
  } catch (err) {
    return { path: filePath, status: 'error', reason: `write failed: ${(err as Error).message}` };
  }
  return { path: filePath, status: applied.status };
}

/** Does this root's `CLAUDE.md` already import `AGENTS.md`? An unreadable or
 *  symlinked file answers `false`, which puts it in the plan as a section write
 *  — where `readInstructionFile` then reports the skip it really deserves. */
function claudeImportsAgentsMd(root: string): boolean {
  try {
    return hasAgentsMdImportLine(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'));
  } catch {
    return false;
  }
}

/** Create a `CLAUDE.md` holding only the `@AGENTS.md` import line.
 *
 *  It never overwrites: the plan said the file was absent, so a file that is
 *  here now (a checkout, another agent, a race) is one Forge did not create and
 *  will not replace. A file that already holds exactly that line is the content
 *  Forge would have written, so it reports `unchanged`. */
function writeAgentNoteImportFile(filePath: string): AgentMeshNoteFileResult {
  const read = readInstructionFile(filePath);
  if (read.skipped) return { path: filePath, status: 'skipped', reason: read.skipped };
  if (read.error) return { path: filePath, status: 'error', reason: read.error };
  if (read.content !== undefined) {
    if (read.content === AGENTS_MD_IMPORT_FILE_CONTENT)
      return { path: filePath, status: 'unchanged' };
    return {
      path: filePath,
      status: 'skipped',
      reason: 'a file appeared after the plan; Forge will not overwrite it',
    };
  }
  try {
    writeFileAtomicSync(filePath, AGENTS_MD_IMPORT_FILE_CONTENT);
  } catch (err) {
    return { path: filePath, status: 'error', reason: `write failed: ${(err as Error).message}` };
  }
  return { path: filePath, status: 'created' };
}

/**
 * Installs the note in every repository root of the workspace.
 *
 * One root, one decision about which files to touch (`agentNoteTargetFiles`):
 * `AGENTS.md` always takes the section, because that is the file Codex and
 * Copilot read and it is created when missing; an existing `CLAUDE.md` takes it
 * too, because that is the file Claude Code reads, unless it already imports
 * `AGENTS.md`, in which case it is left alone; a missing `CLAUDE.md` is created
 * holding only the import line, so Claude sees the section once, not twice.
 */
export function installAgentMeshNote(
  roots: readonly string[],
  facts: AgentMeshNoteFacts,
): AgentMeshNoteFileResult[] {
  const results: AgentMeshNoteFileResult[] = [];
  const note = buildAgentMeshNote(facts);
  for (const root of roots) {
    const existing = AGENT_INSTRUCTION_FILE_NAMES.filter((name) => {
      try {
        return fs.statSync(path.join(root, name)).isFile();
      } catch {
        return false;
      }
    });
    const plan = agentNoteTargetFiles(existing, claudeImportsAgentsMd(root));
    for (const target of plan) {
      const filePath = path.join(root, target.name);
      results.push(
        target.write === 'import'
          ? writeAgentNoteImportFile(filePath)
          : installIntoOneFile(filePath, note),
      );
    }
  }
  return results;
}

/** Replace the section in one file that already holds one; never create, never
 *  append. The one file-level refresh, shared by the workspace note and the
 *  user-wide copy, so "a refresh is replace-only" is one rule and not two. */
export function refreshIntoOneFile(filePath: string, note: string): AgentMeshNoteFileResult {
  const read = readInstructionFile(filePath);
  if (read.skipped) return { path: filePath, status: 'skipped', reason: read.skipped };
  if (read.error) return { path: filePath, status: 'error', reason: read.error };
  if (read.absent) {
    return { path: filePath, status: 'skipped', reason: 'no file; a refresh never creates one' };
  }
  if (read.content === AGENTS_MD_IMPORT_FILE_CONTENT) {
    return {
      path: filePath,
      status: 'skipped',
      reason: 'only the `@AGENTS.md` import: the section lives in the file it imports',
    };
  }
  if (countAgentMeshSections(read.content ?? '') === 0) {
    return {
      path: filePath,
      status: 'skipped',
      reason: 'no marked section: the owner removed it, and a refresh does not re-add it',
    };
  }
  return installIntoOneFile(filePath, note);
}

/**
 * The refresh half of the install: replace, never create, never append.
 *
 * `installAgentMeshNote` may create a file or append a section, because on a
 * first install there is nothing else to do. On a refresh an owner who deleted
 * the marked section has said "no note in this workspace", and adding it back
 * would be Forge disagreeing with a deletion it was told about — criterion 8's
 * case (b). So a file that is absent, or that holds no complete marked section,
 * is skipped with the reason the log and the toast show; only a file that
 * already holds the section gets the new text.
 */
export function refreshAgentMeshNote(
  roots: readonly string[],
  facts: AgentMeshNoteFacts,
): AgentMeshNoteFileResult[] {
  const note = buildAgentMeshNote(facts);
  const results: AgentMeshNoteFileResult[] = [];
  for (const root of roots) {
    for (const name of AGENT_INSTRUCTION_FILE_NAMES) {
      results.push(refreshIntoOneFile(path.join(root, name), note));
    }
  }
  return results;
}

/** Files in these roots that hold a section, whether or not Forge wrote it. */
export function findWorkspaceAgentNotes(roots: readonly string[]): string[] {
  const found: string[] = [];
  for (const root of roots) {
    for (const name of AGENT_INSTRUCTION_FILE_NAMES) {
      const filePath = path.join(root, name);
      try {
        if (countAgentMeshSections(fs.readFileSync(filePath, 'utf8')) > 0) found.push(filePath);
      } catch {
        // Absent or unreadable: nothing to report.
      }
    }
  }
  return found;
}

/** The sentence for the log or the toast: what changed, in the user's words. */
export function describeAgentMeshNoteInstall(results: readonly AgentMeshNoteFileResult[]): string {
  const changed = results.filter((r) => r.status === 'created' || r.status === 'appended');
  const updated = results.filter((r) => r.status === 'replaced');
  const names = (items: readonly AgentMeshNoteFileResult[]): string =>
    [...new Set(items.map((r) => path.basename(r.path)))].join(' and ');
  const parts: string[] = [];
  if (changed.length) parts.push(`added its agent note to ${names(changed)}`);
  if (updated.length) parts.push(`refreshed the marked section in ${names(updated)}`);
  if (!parts.length) {
    const unchanged = results.filter((r) => r.status === 'unchanged');
    if (unchanged.length)
      return `The agent note is already in ${names(unchanged)} — nothing changed.`;
    return 'Nothing to write: every file was skipped or failed.';
  }
  return `Forge ${parts.join(' and ')}. Delete everything between the two \`forge-agent-mesh\` comment lines to remove it.`;
}

export interface AgentMeshNoteCommandDeps {
  getConfig: () => ForgeConfig;
  /** The config file the note should name, so the user edits the right one. */
  getConfigPath: () => string;
}

/** `Forge: Set Up Agent Note`: the same install the automatic bootstrap ran,
 *  on demand, so the note can be refreshed after a config change or re-added
 *  after the user removed it. */
export function registerAgentMeshNoteCommand(
  context: vscode.ExtensionContext,
  deps: AgentMeshNoteCommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(AGENT_NOTE_COMMAND, async () => {
      const config = deps.getConfig();
      const roots = await discoverRoots();
      if (!roots.length) {
        void vscode.window.showInformationMessage(
          'Forge: no folder is open, so there is no workspace to write the note into.',
        );
        return;
      }
      if (config.agent_bus?.enabled !== true) {
        const held = findWorkspaceAgentNotes(roots);
        void vscode.window.showInformationMessage(
          held.length
            ? `The agent mesh is off (\`agent_bus: { enabled: false }\`), so Forge left the existing note in place: ${held.map((p) => path.basename(p)).join(', ')}. Delete the marked section to remove it.`
            : 'The agent mesh is off, so there is nothing for the note to say. Set `agent_bus: { enabled: true }` first.',
        );
        return;
      }
      const results = installAgentMeshNote(roots, agentMeshNoteFacts(config, deps.getConfigPath()));
      const message = describeAgentMeshNoteInstall(results);
      const failures = results.filter((r) => r.status === 'error');
      if (failures.length) {
        void vscode.window.showWarningMessage(
          `${message} Could not write: ${failures.map((f) => `${path.basename(f.path)} (${f.reason})`).join('; ')}`,
        );
      } else {
        void vscode.window.showInformationMessage(message);
      }
    }),
  );
}

/** The roots to write into: the same set `workspaceBootstrap` uses, so the
 *  note lands in the repository the FORGE.md went into. */
async function discoverRoots(): Promise<string[]> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspace) return [];
  return discoverWorkspaceRepositoryRoots(workspace);
}
