import * as fs from 'fs';
import * as path from 'path';
import { isPathInside, resolveRealWorkspacePath } from '../util/WorkspacePaths';
import type { RegisteredTool } from './ToolRegistry';
import {
  formatExecCommandOutput,
  getWorkspaceRoot,
  spawnAndWait,
  type SpawnResult,
} from './execHelpers';

const MAX_LIST_ENTRIES = 50;
const DEFAULT_LIST_ENTRIES = 15;

export type SafePowerShellOperation =
  | 'workspace_overview'
  | 'get_location'
  | 'list_directory'
  | 'get_file_hash';

interface SafePowerShellInvocation {
  readonly program: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

const SAFE_OPERATIONS = new Set<SafePowerShellOperation>([
  'workspace_overview',
  'get_location',
  'list_directory',
  'get_file_hash',
]);

// This script is source-controlled and fixed. Model-controlled values travel
// only through environment variables, never into PowerShell source text.
const SAFE_POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'switch ($env:FORGE_SAFE_PS_OPERATION) {',
  "  'workspace_overview' { (Get-Location).Path; Get-ChildItem -LiteralPath $env:FORGE_SAFE_PS_PATH -Force -Name | Select-Object -First ([int] $env:FORGE_SAFE_PS_LIMIT); break }",
  "  'get_location' { (Get-Location).Path; break }",
  "  'list_directory' { Get-ChildItem -LiteralPath $env:FORGE_SAFE_PS_PATH -Force -Name | Select-Object -First ([int] $env:FORGE_SAFE_PS_LIMIT); break }",
  "  'get_file_hash' { (Get-FileHash -LiteralPath $env:FORGE_SAFE_PS_PATH -Algorithm SHA256).Hash; break }",
  "  default { throw 'Forge safe PowerShell operation was rejected.' }",
  '}',
].join('\n');

function requireOperation(value: unknown): SafePowerShellOperation {
  if (typeof value !== 'string' || !SAFE_OPERATIONS.has(value as SafePowerShellOperation)) {
    throw new Error('query_powershell: operation must be a supported read-only operation.');
  }
  return value as SafePowerShellOperation;
}

function requireListLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIST_ENTRIES;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_LIST_ENTRIES) {
    throw new Error(
      `query_powershell: max_entries must be an integer from 1 to ${MAX_LIST_ENTRIES}.`,
    );
  }
  return value as number;
}

/**
 * The confinement below is deliberate — this is the one tool that runs without
 * the confirmation gate — but a bare "not allowed" taught the agent the
 * capability did not exist. The gated tools accept these paths happily, so the
 * refusal has to say so: an audited session spent 7 of its 9 `query_powershell`
 * calls re-attempting the same out-of-workspace path after every compaction,
 * because nothing in the message pointed anywhere.
 */
function outsideWorkspaceError(operation: SafePowerShellOperation, pathValue: string): Error {
  const alternative =
    operation === 'get_file_hash'
      ? 'the `exec_command` tool'
      : 'the `list_directory` tool (or `read_file` / `find_files`)';
  return new Error(
    `query_powershell: ${pathValue} is outside the workspace. This tool is workspace-relative ` +
      `only, because it is the one tool that runs without asking you first. Use ${alternative} ` +
      `instead — those accept absolute paths anywhere on disk.`,
  );
}

async function resolveReadOnlyPath(
  operation: SafePowerShellOperation,
  pathValue: unknown,
): Promise<string> {
  const root = getWorkspaceRoot();
  if (operation === 'workspace_overview' || operation === 'get_location') return root;
  if (typeof pathValue !== 'string' || !pathValue.trim()) {
    throw new Error(`query_powershell: path is required for ${operation}.`);
  }
  if (path.isAbsolute(pathValue) && !isPathInside(root, path.normalize(pathValue))) {
    throw outsideWorkspaceError(operation, pathValue);
  }
  let resolved: string;
  try {
    resolved = await resolveRealWorkspacePath(pathValue, root, { relativeOnly: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `relativeOnly` rejects an absolute path before containment is checked, so
    // an absolute path *inside* the workspace lands here too. It is usable —
    // relative to the root — and saying so is cheaper than a second attempt.
    if (message.startsWith('Absolute paths are not allowed') && path.isAbsolute(pathValue)) {
      throw new Error(
        `query_powershell: pass a workspace-relative path, not ${pathValue}. ` +
          `Relative to the workspace root that is ${path.relative(root, path.normalize(pathValue))}.`,
      );
    }
    if (message.startsWith('Path is outside the workspace')) {
      throw outsideWorkspaceError(operation, pathValue);
    }
    throw err;
  }
  const stat = fs.statSync(resolved);
  if (operation === 'list_directory' && !stat.isDirectory()) {
    throw new Error(`query_powershell: path is not a directory: ${pathValue}`);
  }
  if (operation === 'get_file_hash' && !stat.isFile()) {
    throw new Error(`query_powershell: path is not a file: ${pathValue}`);
  }
  return resolved;
}

export function buildSafePowerShellInvocation(
  operation: SafePowerShellOperation,
  targetPath: string,
  maxEntries: number,
): SafePowerShellInvocation {
  return {
    program: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SAFE_POWERSHELL_SCRIPT],
    env: {
      FORGE_SAFE_PS_OPERATION: operation,
      FORGE_SAFE_PS_PATH: targetPath,
      FORGE_SAFE_PS_LIMIT: String(maxEntries),
    },
  };
}

function formatSafePowerShellOutput(
  operation: SafePowerShellOperation,
  result: SpawnResult,
): string {
  return formatExecCommandOutput(`powershell.exe:${operation}`, result);
}

/**
 * Unattended PowerShell inspection without accepting a model-authored script.
 * It is intentionally read-only and workspace-confined, so it is the only
 * headless tool that bypasses Forge's normal confirmation gate.
 */
export function makeSafePowerShellTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'query_powershell',
        description:
          'Run one structured, read-only PowerShell inspection in this workspace without user confirmation. Supports workspace_overview, get_location, list_directory, and get_file_hash. It never accepts a raw PowerShell command or script.',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['workspace_overview', 'get_location', 'list_directory', 'get_file_hash'],
              description: 'The fixed read-only PowerShell operation to run.',
            },
            path: {
              type: 'string',
              description:
                'Workspace-relative existing path (never absolute). Required for list_directory ' +
                'and get_file_hash. For anything outside the workspace root, use list_directory / ' +
                'read_file / find_files instead — this tool cannot reach it.',
            },
            max_entries: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_LIST_ENTRIES,
              description: 'Maximum directory entries to return. Default 15.',
            },
          },
          required: ['operation'],
          additionalProperties: false,
        },
      },
    },
    permission: 'headless',
    autoApprove: true,
    handler: async (args) => {
      const operation = requireOperation(args['operation']);
      const maxEntries = requireListLimit(args['max_entries']);
      const targetPath = await resolveReadOnlyPath(operation, args['path']);
      const invocation = buildSafePowerShellInvocation(operation, targetPath, maxEntries);
      const result = await spawnAndWait(
        invocation.program,
        [...invocation.args],
        getWorkspaceRoot(),
        30_000,
        invocation.env,
      );
      return formatSafePowerShellOutput(operation, result);
    },
  };
}
