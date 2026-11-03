/**
 * The `tailscale serve` shapes: the argv Forge would run, the same command as
 * text for the owner to paste, and what `serve status --json` says is already
 * shared.
 *
 * Split out of `desktopSharePlan.ts` because these are the CLI's own shapes —
 * strings in, strings out — while the plan module decides *which* ports to
 * share and which config switches to move. A test that asks "does Share ever
 * name a port it must not share" does not need a `model_starter` block, and a
 * test of the command text does not need a config at all. `tailscaleCli.ts` is
 * the third piece of this trio: the child process that runs the argv, which
 * never decides what to run.
 *
 * Nothing here runs anything: `runTailscaleCli` does, and only after the owner
 * has confirmed the dialog that showed these exact strings — so the strings
 * shown and the strings run are built in one place and cannot drift.
 */

/** What `tailscale serve` already forwards, read from `serve status --json`.
 *  A `Map` because the plan needs "is this port shared, and to what" for exactly
 *  the two ports it cares about, and nothing else on the machine. */
export interface ServeStatus {
  /** Port → what the tailnet forwards it to, as the CLI reported it. */
  forwards: Map<number, string>;
  /** Ports shared some other way (HTTP or HTTPS handlers), for the note that
   *  says Forge only touches its own two and leaves the rest of the shares. */
  otherPorts: number[];
}

/** `serve --bg --tcp <port> tcp://127.0.0.1:<port>`: the form the owner ran for
 *  both services (`docs/plans/LAPTOP_LAN_ACCESS_PLAN.md` Phase 4 and
 *  `LAPTOP_CLOUD_RELAY_PLAN.md` Phase 0). `--bg` applies it without a prompt,
 *  which is what makes it safe to run from a child process with no terminal. */
export function serveShareArgs(port: number): string[] {
  return ['serve', '--bg', '--tcp', String(port), `tcp://127.0.0.1:${port}`];
}

/** `serve --tcp=<port> off`: removes that one share and nothing else, so
 *  `Stop sharing` cannot reset a share it did not make. */
export function serveUnshareArgs(port: number): string[] {
  return ['serve', `--tcp=${port}`, 'off'];
}

/** The command as the owner would run or paste it. Windows needs the quotes
 *  around a path with spaces; the same string is what the tests compare against,
 *  so what is shown and what is run cannot drift apart. */
export function renderTailscaleCommand(executable: string, args: string[]): string {
  return `${executable.includes(' ') ? `"${executable}"` : executable} ${args.join(' ')}`;
}

/** `tailscale serve status --json` → the forwards Forge cares about. Anything
 *  unparsable is the caller's `statusFailure`, not a silent empty answer: a CLI
 *  that answered something else must not read as "nothing is shared". */
export function parseServeStatus(text: string): ServeStatus {
  const parsed: unknown = JSON.parse(text || '{}');
  const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const forwards = new Map<number, string>();
  const otherPorts: number[] = [];
  for (const [section, value] of Object.entries(record)) {
    const entries = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    for (const [key, inner] of Object.entries(entries)) {
      const port = Number(key);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const target =
        inner && typeof inner === 'object'
          ? ((inner as Record<string, unknown>)['TCPForward'] ?? null)
          : null;
      if (section === 'TCP' && typeof target === 'string') {
        forwards.set(port, target);
        continue;
      }
      // An HTTP or HTTPS handler on this port is somebody else's share: Forge
      // leaves it alone and says it is there.
      otherPorts.push(port);
    }
  }
  return { forwards, otherPorts: [...new Set(otherPorts)].sort((a, b) => a - b) };
}
