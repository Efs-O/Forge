import * as fs from 'fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

const { outputHome } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  return { outputHome: fs.mkdtempSync(path.join(os.tmpdir(), 'forge-git-cap-')) };
});
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => outputHome,
}));
afterAll(() => fs.rmSync(outputHome, { recursive: true, force: true }));

const huge = `${'h'.repeat(20_000)}${'m'.repeat(40_000)}${'t'.repeat(20_000)}`;
const makeHandler = () => ({ handler: async () => huge });
vi.mock('../../src/tools/gitReadTools', () => ({
  makeGitStatusTool: makeHandler,
  makeGitLogTool: makeHandler,
  makeGitDiffTool: makeHandler,
  makeGitBlameTool: makeHandler,
  makeGitShowTool: makeHandler,
}));

const { makeGitReadTool } = await import('../../src/tools/gitReadTool');

describe('git_read output cap', () => {
  it('refuses a partial blame answer instead of hiding missing middle lines in a success', async () => {
    await expect(
      makeGitReadTool().handler(
        { operation: 'blame', path: 'large.txt', start_line: 5, end_line: 100 },
        {
          beforeMutate: () => {},
          conversationId: 'blame-chat',
          toolCallId: 'blame-call',
          outputLimits: { shellInlineChars: 1000 } as never,
        },
      ),
    ).rejects.toThrow(
      'git_read blame: output exceeds the 1000-character inline limit. Request a smaller range with start_line and end_line (for example, start_line: 1, end_line: 20). No blame lines were returned; use git_read log for commit history.',
    );
  });

  it('keeps head and tail of a huge diff and spills the full text', async () => {
    const result = await makeGitReadTool().handler(
      { operation: 'diff' },
      { beforeMutate: () => {}, conversationId: 'git-cap-test', toolCallId: 'call-1' },
    );
    expect(typeof result).toBe('string');
    const text = result as string;
    expect(text.length).toBeLessThan(31_000);
    expect(text.startsWith('h'.repeat(100))).toBe(true);
    expect(text.endsWith('t'.repeat(100))).toBe(true);
    const spill = /Full output: (.+?) —/u.exec(text)?.[1];
    expect(spill).toBeDefined();
    expect(fs.readFileSync(spill!, 'utf8')).toBe(huge);
    fs.rmSync(spill!, { force: true });
  });
});
