import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { relayToClaude } from '../../src/agentBus/claudeRelay';

let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-claude-relay-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

/**
 * A fake `claude`: records its argv and stdin, then prints `reply`. A .cmd shim
 * on Windows (the path spawnCliProcess wraps), a node shebang elsewhere.
 */
function fakeClaude(reply: string, exitCode = 0): { cli: string; record: string } {
  const record = path.join(dir, 'record.json');
  const js = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(
    js,
    `let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), input }));
  process.stdout.write(${JSON.stringify(reply)});
  process.exit(${exitCode});
});
`,
  );
  if (process.platform === 'win32') {
    const cli = path.join(dir, 'claude.cmd');
    fs.writeFileSync(cli, `@"${process.execPath}" "${js}" %*\r\n`);
    return { cli, record };
  }
  const cli = path.join(dir, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\n${fs.readFileSync(js, 'utf8')}`, { mode: 0o755 });
  return { cli, record };
}

describe('relayToClaude', () => {
  it('runs claude -p with only SendMessage and passes the message on stdin', async () => {
    const { cli, record } = fakeClaude('SENT\n');
    await relayToClaude(cli, 'haiku', 'forge-dd', 'hello "quoted" & <tagged>');
    const seen = JSON.parse(fs.readFileSync(record, 'utf8'));
    expect(seen.args).toEqual([
      '-p',
      '--model',
      'haiku',
      '--allowedTools',
      'SendMessage',
      '--output-format',
      'text',
    ]);
    expect(seen.input).toContain('named "forge-dd"');
    expect(seen.input.endsWith('hello "quoted" & <tagged>')).toBe(true);
  }, 30_000);

  it('fails with the output when the relay does not confirm', async () => {
    const { cli } = fakeClaude('FAILED: no session named forge-dd\n');
    await expect(relayToClaude(cli, 'haiku', 'forge-dd', 'x')).rejects.toThrow(
      /did not confirm.*no session named forge-dd/,
    );
  }, 30_000);

  it('fails on a non-zero exit even if the output says SENT', async () => {
    const { cli } = fakeClaude('SENT', 3);
    await expect(relayToClaude(cli, 'haiku', 'forge-dd', 'x')).rejects.toThrow(/exit 3/);
  }, 30_000);

  it('fails clearly when the executable is missing', async () => {
    await expect(
      relayToClaude(path.join(dir, 'nope', 'claude'), 'haiku', 'forge-dd', 'x'),
    ).rejects.toThrow(/not found/);
  });
});
