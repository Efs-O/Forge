import { describe, expect, it } from 'vitest';
import {
  cliProcessFailureLine,
  cliSpawnFailureMessage,
  waitForCliSpawn,
} from '../../src/agents/cliStartFailure';
import { fakeCliChild } from '../support/fakeCli';

/** The message both warm sessions must produce for a child that never started.
 *  It is asserted here, in the module that owns it, so the two session classes
 *  cannot drift into two different wordings of the same failure. */
describe('cliSpawnFailureMessage', () => {
  it('names the code, the message and the executable Forge was asked to run', () => {
    const error = Object.assign(new Error('spawn forge_probe_missing_program ENOENT'), {
      code: 'ENOENT',
    });
    expect(cliSpawnFailureMessage('Claude', 'forge_probe_missing_program', error)).toBe(
      "Couldn't start Claude: ENOENT (spawn forge_probe_missing_program ENOENT). " +
        'Executable: forge_probe_missing_program',
    );
  });

  it('does not repeat the message when the OS gave no code', () => {
    expect(cliSpawnFailureMessage('Codex', '/opt/codex', new Error('permission denied'))).toBe(
      "Couldn't start Codex: permission denied. Executable: /opt/codex",
    );
  });
});

describe('waitForCliSpawn', () => {
  it('answers undefined once the child reports spawn, and records nothing', async () => {
    const { child } = fakeCliChild('probe_program', {});
    const recorded: string[] = [];
    const outcome = await waitForCliSpawn(child, 'Claude', 'probe_program', (message) =>
      recorded.push(message),
    );
    expect(outcome).toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it('records the failure synchronously, before any later handler can pick a message', async () => {
    // The whole point of the named field: the exit watcher's promise handler
    // runs a microtask after the `error` event, and until now that delay let
    // the write error decide what the user was told. Recording inside the
    // listener means the order no longer matters.
    const { child } = fakeCliChild('forge_probe_missing_program', {
      spawnError: { code: 'ENOENT' },
    });
    const recorded: string[] = [];
    const gate = waitForCliSpawn(child, 'Claude', 'forge_probe_missing_program', (message) =>
      recorded.push(message),
    );
    // One tick is the event; the promise handler below is a microtask later.
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain("Couldn't start Claude");
    expect(await gate).toBe(recorded[0]);
  });

  it('answers at once for a child that has already exited', async () => {
    // `spawn` is reported once. A warm session's next send must not attach new
    // listeners and wait for an event that already happened — that is what
    // hung the second warm turn before this was moved out of the send path.
    const { child } = fakeCliChild('probe_program', { exit: { code: 0 } });
    await new Promise((resolve) => setImmediate(resolve));
    const recorded: string[] = [];
    const outcome = await waitForCliSpawn(child, 'Claude', 'probe_program', (message) =>
      recorded.push(message),
    );
    expect(outcome).toBeUndefined();
    expect(recorded).toEqual([]);
  });
});

describe('cliProcessFailureLine', () => {
  it('carries the reason, the exit code or signal, the executable and the tail', () => {
    const line = cliProcessFailureLine(
      'claude',
      'Claude CLI exited with code 1.',
      'C:\\npm\\codex.cmd',
      { code: 1 },
      'SIGTERM',
      'claude: boom, something broke',
    );
    expect(line).toBe(
      '[cli-agent] claude failed: Claude CLI exited with code 1. code=1 signal=SIGTERM ' +
        'exe=C:\\npm\\codex.cmd stderr=claude: boom, something broke',
    );
    // No environment value is ever in it: the child env is where the user's
    // tokens sit, and this channel is mirrored into `.forge/sessions/*.jsonl`.
    expect(line).not.toContain('PATH=');
    expect(line).not.toContain('env=');
  });

  it('reports a spawn error with no exit code, no signal and no tail', () => {
    const line = cliProcessFailureLine(
      'codex app-server',
      'Codex app-server transport failed: spawn codex ENOENT',
      'codex',
      { code: null, error: new Error('spawn codex ENOENT') },
      null,
      '',
    );
    expect(line).toContain('code=null');
    expect(line).toContain('signal=none');
    expect(line).not.toContain('stderr=');
  });
});
