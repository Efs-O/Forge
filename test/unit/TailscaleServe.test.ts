/**
 * The `tailscale serve` shapes (`src/vscode/tailscaleServe.ts`), which are the
 * strings the owner sees in the Share dialog and the strings Forge then runs.
 *
 * Two things are pinned here and nowhere else: the argv is what the Tailscale
 * CLI actually takes (`--bg` so a change applies with no prompt, `--tcp=<port>
 * off` so `Stop sharing` removes exactly one share and cannot reset a share it
 * did not make), and `serve status --json` is read as "is this port forwarded,
 * and to what" rather than as "is this port shared at all" — because a port
 * forwarded to the wrong loopback port has to be re-pointed, not reported as
 * already right.
 *
 * No config, no window and no child process in this file: the CLI itself is
 * `TailscaleCli.test.ts`, and the decisions about which ports go into these
 * shapes are `DesktopSharePlan.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  parseServeStatus,
  renderTailscaleCommand,
  serveShareArgs,
  serveUnshareArgs,
} from '../../src/vscode/tailscaleServe';

describe('the serve commands Forge runs', () => {
  it('shares one port to the loopback address Forge listens on, with --bg so no prompt', () => {
    expect(serveShareArgs(8798)).toEqual([
      'serve',
      '--bg',
      '--tcp',
      '8798',
      'tcp://127.0.0.1:8798',
    ]);
  });

  it('turns off one share by its own port, so Stop cannot reset another', () => {
    expect(serveUnshareArgs(8797)).toEqual(['serve', '--tcp=8797', 'off']);
    expect(serveUnshareArgs(8797).join(' ')).not.toContain('reset');
  });

  it('quotes the path when it has a space, and not when it does not', () => {
    // The same string is what the tests compare the injected runner against, so
    // the line the owner reads in the dialog and the line Forge runs are one
    // string built in one place.
    expect(
      renderTailscaleCommand('C:/Program Files/Tailscale/tailscale.exe', serveShareArgs(8798)),
    ).toBe(
      '"C:/Program Files/Tailscale/tailscale.exe" serve --bg --tcp 8798 tcp://127.0.0.1:8798',
    );
    expect(renderTailscaleCommand('tailscale', serveUnshareArgs(8797))).toBe(
      'tailscale serve --tcp=8797 off',
    );
  });
});

describe('what serve status --json already forwards', () => {
  it('reads the forwards Forge cares about, and the ports shared some other way', () => {
    const status = parseServeStatus(`{
      "Version": 2,
      "TCP": {
        "443": { "EnableTcp": true, "HTTPS": true },
        "8798": { "EnableTcp": true, "TCPForward": "127.0.0.1:8798" },
        "8797": { "EnableTcp": true, "TCPForward": "127.0.0.1:8080" }
      },
      "Web": { "desk.example.ts:443": { "Handler": { "Proxy": { "127.0.0.1:3000": "" } } } }
    }`);
    expect(Object.fromEntries(status.forwards)).toEqual({
      '8797': '127.0.0.1:8080',
      '8798': '127.0.0.1:8798',
    });
    // 443 is in the TCP section but has no TCPForward: it is HTTPS on the
    // tailnet, somebody else's share, so Forge reports it and leaves it alone.
    expect(status.otherPorts).toEqual([443]);
  });

  it('a port that is not a port, or not in range, is not read as a share', () => {
    const status = parseServeStatus('{"TCP":{"abc":{"TCPForward":"127.0.0.1:1"},"99999":{"TCPForward":"x"}}}');
    expect(status.forwards.size).toBe(0);
    expect(status.otherPorts).toEqual([]);
  });

  it('an empty answer is read as nothing shared, because the commands are idempotent', () => {
    // A `serve status` that answered with nothing is not a failure, and guessing
    // "nothing is shared" is the safe side: re-sharing a port that is already
    // shared changes nothing, while assuming it is shared when it is not leaves
    // a laptop unable to connect with a message that says everything is fine.
    const status = parseServeStatus('');
    expect(status.forwards.size).toBe(0);
    expect(status.otherPorts).toEqual([]);
  });

  it('something that is not JSON is the failure the caller reports, not an empty tailnet', () => {
    expect(() => parseServeStatus('not json')).toThrow();
    expect(() => parseServeStatus('tailscale: command not found')).toThrow();
  });
});
