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
