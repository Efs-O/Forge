import * as fs from 'fs';
import { describe, expect, it, vi } from 'vitest';

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
