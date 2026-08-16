import { describe, expect, it } from 'vitest';
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

  it('uses a non-interactive profile-free PowerShell invocation', () => {
    const invocation = buildSafePowerShellInvocation('workspace_overview', 'N:\\workspace', 15);

    expect(invocation.program).toBe('powershell.exe');
    expect(invocation.args).toEqual(
      expect.arrayContaining(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']),
    );
    expect(invocation.env['FORGE_SAFE_PS_OPERATION']).toBe('workspace_overview');
  });
});
