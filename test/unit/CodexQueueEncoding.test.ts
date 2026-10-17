import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexMessage, queueToCodex } from '../../src/agentBus/codexDelivery';

const { resolveExecutable } = vi.hoisted(() => ({ resolveExecutable: vi.fn() }));

vi.mock('../../src/agents/resolveCliExecutable', () => ({
  resolveCliExecutable: resolveExecutable,
}));

const thread = '12345678-1234-1234-1234-123456789abc';
const replyPath = 'C:\\Users\\tester\\.forge\\agent-bus\\outbox\\fg1791234567890-12345678-reply.md';

// Every codexMessage has blank lines. Through cmd.exe a line break ends the
// command, so the open Codex session received the subject line and nothing
// else: no question, no reply instructions, and the asker waited 20 minutes.
describe.runIf(process.platform === 'win32')('codex queue message delivery', () => {
  let dir: string;
  let argvFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge codex queue '));
    argvFile = path.join(dir, 'argv.json');
    const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('delivers the whole multi-line message through an npm shim', async () => {
    const shim = path.join(dir, 'codex.cmd');
    fs.writeFileSync(
      shim,
      '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n' +
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ' +
        '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    );
    resolveExecutable.mockResolvedValue(shim);
    const message = codexMessage(replyPath, 'fg1791234567890-12345678', 's', 'a & b\n"%PATH%"');

    await queueToCodex('codex', thread, message);

    expect(JSON.parse(fs.readFileSync(argvFile, 'utf8'))).toEqual([
      'queue',
      '--thread',
      thread,
      '--message',
      message,
    ]);
  });

  it('refuses before spawning when the shim can only run through cmd.exe', async () => {
    const shim = path.join(dir, 'codex.bat');
    fs.writeFileSync(shim, `@node "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`);
    resolveExecutable.mockResolvedValue(shim);
    const message = codexMessage(replyPath, 'fg1791234567890-12345678', 's', 'question');

    await expect(queueToCodex('codex', thread, message)).rejects.toThrow(/line break/);
    expect(fs.existsSync(argvFile)).toBe(false);
  });
});
