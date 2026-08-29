import { describe, expect, it } from 'vitest';
import { latestPastedTerminalCommand } from '../../src/sidebar/compactionLedger';
import { injectTurnContext } from '../../src/sidebar/turnContext';

describe('terminal command context', () => {
  it('uses the latest Forge-pasted command and its intended cwd', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id: 'first',
            type: 'function' as const,
            function: { name: 'run_terminal', arguments: '{"command":"npm test","cwd":"old"}' },
          },
          {
            id: 'last',
            type: 'function' as const,
            function: {
              name: 'run_terminal',
              arguments: '{"command":"npm run ci","cwd":"N:/Forge"}',
            },
          },
        ],
      },
      { role: 'user' as const, content: 'The command did not work. Why?' },
    ];

    expect(latestPastedTerminalCommand(messages)).toEqual({
      command: 'npm run ci',
      cwd: 'N:/Forge',
    });
  });

  it('puts the known command and live terminal cwd in the next user turn', () => {
    const output = injectTurnContext(
      [{ role: 'user', content: 'The command did not work. Why?' }],
      {
        pastedTerminalCommand: { command: 'npm run ci', cwd: 'N:/Forge' },
        activeTerminalCwd: 'C:/Users/example',
      },
    );

    expect(output[0]?.content).toContain('Most recent Forge-pasted terminal command');
    expect(output[0]?.content).toContain('npm run ci');
    expect(output[0]?.content).toContain('Intended working directory: N:/Forge');
    expect(output[0]?.content).toContain('Active VS Code terminal working directory: C:/Users/example');
  });

  it('includes a scoped captured result when Forge has one', () => {
    const output = injectTurnContext(
      [{ role: 'user', content: 'The command did not work. Why?' }],
      {
        terminalCommandResult: {
          command: 'python render_clips.p',
          intendedCwd: 'N:/Forge',
          status: 'completed',
          exitCode: 2,
          output: "can't open file 'render_clips.p'",
          outputTruncated: false,
        },
      },
    );

    expect(output[0]?.content).toContain('completed with exit code 2');
    expect(output[0]?.content).toContain("can't open file 'render_clips.p'");
  });
});

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
