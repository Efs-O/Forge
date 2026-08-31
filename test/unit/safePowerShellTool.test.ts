import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  buildSafePowerShellInvocation,
  makeSafePowerShellTool,
} from '../../src/tools/safePowerShellTool';

describe('query_powershell', () => {
  it('is headless but limited to structurally safe operations', () => {
    const tool = makeSafePowerShellTool();

    expect(tool.permission).toBe('headless');
    expect(tool.autoApprove).toBe(true);
    expect(tool.definition.function.parameters).toMatchObject({
      additionalProperties: false,
      required: ['operation'],
    });
  });

  it('keeps model-controlled values out of the PowerShell source', () => {
    const hostilePath = "x'; Remove-Item -Recurse -Force C:\\; #";
    const invocation = buildSafePowerShellInvocation('list_directory', hostilePath, 15);

    expect(invocation.args.at(-1)).not.toContain(hostilePath);
    expect(invocation.args.at(-1)).toContain('Get-ChildItem -LiteralPath');
    expect(invocation.args.at(-1)).toContain('\nswitch ($env:FORGE_SAFE_PS_OPERATION) {\n');
    expect(invocation.args.at(-1)).not.toContain('{;');
    expect(invocation.env['FORGE_SAFE_PS_PATH']).toBe(hostilePath);
  });

  it('lists processes with the name as a comparison value, never as source text', () => {
    const hostile = "llama*'; Remove-Item -Recurse -Force C:\; #";
    const invocation = buildSafePowerShellInvocation('list_processes', 'N:\ws', 15, hostile);
    const script = invocation.args.at(-1) ?? '';

    expect(script).not.toContain(hostile);
    expect(invocation.env['FORGE_SAFE_PS_NAME']).toBe(hostile);
    // -like against the env var, not a WQL -Filter built by string concatenation.
    expect(script).toContain('$_.Name -like $env:FORGE_SAFE_PS_NAME');
    expect(script).not.toContain('-Filter');
    expect(script).toContain('ProcessId, Name, CommandLine');
  });

  it('refuses list_processes without a name, and says why', async () => {
    const tool = makeSafePowerShellTool();
    await expect(tool.handler({ operation: 'list_processes' })).rejects.toThrow(
      /name is required for list_processes.*llama-server/su,
    );
    await expect(
      tool.handler({ operation: 'list_processes', name: 'x'.repeat(121) }),
    ).rejects.toThrow(/120 characters or fewer/u);
  });

  it('offers list_processes in its schema', () => {
    const params = makeSafePowerShellTool().definition.function.parameters as {
      properties: { operation: { enum: string[] }; name: { type: string } };
    };
    expect(params.properties.operation.enum).toContain('list_processes');
    expect(params.properties.name.type).toBe('string');
  });

  it('uses a non-interactive profile-free PowerShell invocation', () => {
    const invocation = buildSafePowerShellInvocation('workspace_overview', 'N:\\workspace', 15);

    expect(invocation.program).toBe('powershell.exe');
    expect(invocation.args).toEqual(
      expect.arrayContaining(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']),
    );
    expect(invocation.env['FORGE_SAFE_PS_OPERATION']).toBe('workspace_overview');
  });
});

describe('query_powershell refusals name the sanctioned alternative', () => {
  // The confinement is deliberate — this tool skips the confirmation gate — so
  // the tests below assert the *wording*, not the boundary. A bare refusal is
  // what made an agent burn 7 of 9 calls re-attempting the same path.
  let root: string;
  let outside: string;

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sps-'));
    root = path.join(base, 'workspace');
    outside = path.join(base, 'elsewhere');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    vscode.workspace.workspaceFolders.push({ uri: { fsPath: root } });
  });

  afterAll(() => {
    vscode.workspace.workspaceFolders.length = 0;
  });

  const run = (args: Record<string, unknown>) => makeSafePowerShellTool().handler(args);

  it('points an out-of-workspace list_directory at the gated file tools', async () => {
    await expect(run({ operation: 'list_directory', path: outside })).rejects.toThrow(
      /outside the workspace[\s\S]*`list_directory` tool/,
    );
  });

  it('points an out-of-workspace get_file_hash at exec_command', async () => {
    await expect(
      run({ operation: 'get_file_hash', path: path.join(outside, 'f.txt') }),
    ).rejects.toThrow(/`exec_command`/);
  });

  it('hands back the relative form for an absolute path inside the workspace', async () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    await expect(
      run({ operation: 'list_directory', path: path.join(root, 'src') }),
    ).rejects.toThrow(/workspace-relative path[\s\S]*that is src/);
  });

  it('never refuses without saying where to go instead', async () => {
    const message = await run({ operation: 'list_directory', path: outside }).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(message).not.toMatch(/^Absolute paths are not allowed/);
    expect(message).toMatch(/instead/);
  });
});
