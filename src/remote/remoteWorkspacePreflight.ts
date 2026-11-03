/**
 * Before a workspace switch opens anything, ask what the window that comes up
 * will load, and whether it can answer the phone at all.
 *
 * The switch is recorded durably and the window that asked stops its
 * transports, so a target whose own config turns remote off is not a harmless
 * landing: the phone has moved to a window that will never start a transport,
 * and the chat sits silent until its record expires. Checking costs one file
 * read and says so up front, naming the file that has to change.
 *
 * `forge.configFile` is **machine-scoped** (`package.json`:463), so VS Code
 * applies it only at user/remote scope and refuses it in a folder's
 * `.vscode/settings.json` or in a `.code-workspace` `settings` block ("This
 * setting cannot be applied in this workspace"). The target window therefore
 * reads the same value this window does, and a folder-level pin is something
 * this check must **ignore**: honouring it would approve or refuse on a file the
 * target will not load. What the target *does* read is the folder its first
 * workspace entry resolves to, so a `.code-workspace` target is resolved
 * through `folders[0]` the way the target window resolves it — which is the one
 * part of a workspace file that still matters here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findConfigPathFor, loadConfig } from '../config/ConfigLoader';
import type { ForgeConfig } from '../config/types';

export interface WorkspacePreflightDeps {
  /** The alias's configured path — a folder, or a `.code-workspace` file. */
  targetPath: string;
  /** The channel this chat is on: remote on but this channel off still cannot
   *  answer, and that is the owner's whole reason for switching. `fake` is the
   *  test channel and has no config of its own, so it is not a switch target. */
  channel: 'telegram' | 'whatsapp';
  globalStoragePath: string;
  /** The user-scope `forge.configFile`, read by the vscode layer: the target
   *  window reads the same user settings this window does, and nothing else
   *  can set this machine-scoped setting, so this is the whole of it. */
  userConfigFileSetting?: string | undefined;
}

export type WorkspacePreflight =
  | { ok: true; configPath: string | null }
  | { ok: false; reason: string };

const isWorkspaceFile = (targetPath: string): boolean =>
  targetPath.toLowerCase().endsWith('.code-workspace');

/** Read a JSON file VS Code allows comments and trailing commas in —
 *  `.code-workspace` files are JSONC, and a commented one is not a broken one,
 *  so stripping comments is what makes this agree with the target window. A
 *  file that still will not parse yields `null`, which is what a window that
 *  cannot read it has: no folders, and nothing to resolve. */
function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Strip the `//` and `/* * /` comments and trailing commas VS Code allows in
 *  JSONC, without eating a `//` that is inside a string. */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

/** A workspace file's first folder entry, as `vscode.workspace.workspaceFolders`
 *  would report it: `path` is relative to the workspace file itself, `uri` is
 *  only readable here when it names a local file. Anything else — a remote or
 *  virtual folder, a malformed entry, no folders — yields `null`, which is what
 *  the target window has too: no root, so only global storage is left. */
function firstWorkspaceFolder(file: string): string | null {
  const doc = readJsonObject(file);
  const entry = Array.isArray(doc?.folders) ? doc?.folders[0] : undefined;
  if (!entry || typeof entry !== 'object') return null;
  const fields = entry as Record<string, unknown>;
  if (typeof fields.path === 'string') return path.resolve(path.dirname(file), fields.path);
  if (typeof fields.uri === 'string' && /^file:\/\//i.test(fields.uri)) {
    try {
      // `path.resolve` also puts a drive letter back in upper case, which is
      // how `pathToFileURL` reported it lowercased, so the root this check uses
      // is byte-identical to the one the target window sees.
      return path.resolve(
        decodeURIComponent(new URL(fields.uri).pathname.replace(/^\/(?=[A-Za-z]:)/, '')),
      );
    } catch {
      return null;
    }
  }
  return null;
}

/** The folder the target window will treat as its workspace root, which is
 *  where its `.forge/config.yaml` sits. */
function workspaceRootOf(targetPath: string): string | null {
  return isWorkspaceFile(targetPath) ? firstWorkspaceFolder(targetPath) : targetPath;
}

const labelOf = (targetPath: string): string => path.basename(targetPath.replace(/[/\\]+$/, ''));

/** What the target window will load, and whether it can serve the phone. */
export function preflightRemoteWorkspaceSwitch(deps: WorkspacePreflightDeps): WorkspacePreflight {
  const workspaceRoot = workspaceRootOf(deps.targetPath);
  const configPath = findConfigPathFor(
    workspaceRoot,
    deps.globalStoragePath,
    deps.userConfigFileSetting ?? null,
  );
  const target = labelOf(deps.targetPath);
  if (!configPath) {
    return {
      ok: false,
      reason:
        `${target} has no Forge config to load — ` +
        (workspaceRoot
          ? `${workspaceRoot} has no .forge/config.yaml and global storage has none either`
          : 'its folders cannot be read from here and global storage has no Forge config') +
        ', so the window that opens it could not answer the phone.',
    };
  }
  let config: ForgeConfig;
  try {
    config = loadConfig(path.dirname(configPath));
  } catch (err) {
    return {
      ok: false,
      reason: `${target} loads ${configPath}, which will not parse: ${(err as Error).message.replace(/\n/g, ' ')}`,
    };
  }
  if (config.remote?.enabled !== true) {
    return {
      ok: false,
      reason:
        `${target} starts with remote off (${configPath}). Your phone would move to a window ` +
        'that never starts a transport — set remote.enabled: true there first.',
    };
  }
  if (config.remote[deps.channel].enabled !== true) {
    return {
      ok: false,
      reason:
        `${target} starts with ${deps.channel} off (${configPath}), so this chat would have ` +
        `nothing to answer it. Set remote.${deps.channel}.enabled: true there first.`,
    };
  }
  return { ok: true, configPath };
}
