import { describe, expect, it } from 'vitest';
import { injectTurnContext } from '../../src/sidebar/turnContext';

describe('user terminal commands in turn context', () => {
  it('shows the newest command and any earlier failures, with the correction instruction', () => {
    const output = injectTurnContext(
      [{ role: 'user', content: 'why did that fail?' }],
      {
        userTerminalCommands: [
          {
            command: 'npm run buidl',
            terminalName: 'pwsh',
            status: 'completed',
            cwd: 'N:/Forge',
            exitCode: 1,
            output: "Missing script: 'buidl'",
            outputTruncated: false,
          },
          {
            command: 'git psuh',
            terminalName: 'pwsh',
            status: 'completed',
            exitCode: 1,
            output: "git: 'psuh' is not a git command",
            outputTruncated: false,
          },
          {
            command: 'ls',
            terminalName: 'pwsh',
            status: 'completed',
            exitCode: 0,
            outputTruncated: false,
          },
        ],
      },
    );
    const content = String(output[0]?.content);

    expect(content).toContain('npm run buidl');
    expect(content).toContain("Missing script: 'buidl'");
    expect(content).toContain('git psuh');
    // A successful older command is noise once a newer one is present.
    expect(content).not.toContain('\n- ls\n');
    expect(content).toContain('give the corrected command in chat');
  });

  it('says nothing when no user commands were captured', () => {
    const output = injectTurnContext([{ role: 'user', content: 'hi' }], {});
    expect(String(output[0]?.content)).not.toContain('own terminal');
  });
});
