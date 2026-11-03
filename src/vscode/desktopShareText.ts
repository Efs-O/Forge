/**
 * What `Forge: Share this computer` and `Forge: Stop sharing this computer`
 * tell the owner: the two standing warnings, the record of what a run did to the
 * tailnet, and the message after it.
 *
 * Split out of `desktopSharePlan.ts` for the same reason the `serve` shapes
 * were: a message is not a decision. The plan module says which ports to share
 * and which switches to move; this module says what that means in words, and a
 * test that only wants to know what the owner will read does not need a
 * `ForgeConfig` at all.
 *
 * The rule the split makes visible, and that the tests pin: a message may not
 * claim more than the run did. `Stop sharing` turns off two shares, so its
 * message says two and names every OTHER port still forwarded on the machine —
 * on this desktop the nine hand-shared model ports 8070, 8080-8083, 8090-8092
 * and 8094 stay reachable after `Stop sharing`, and a message that said only "a
 * laptop can no longer reach this computer" would read as "the machine is closed
 * to the tailnet", which is false.
 */

/** Always shown, whatever else the dialog says. It is the one thing Forge cannot
 *  do for the owner and the most common reason a "shared" desktop is refused. */
export const ACL_NOTE =
  'Forge does not change the Tailscale ACL, Tailnet Lock or sign-in, and never signs you in. ' +
  'Who may connect is set in the Tailscale admin page: until a rule lets your laptop reach these ' +
  'ports, sharing is on here and the laptop still cannot connect.';

/** A tunnel or SSH window is not the desktop's own window: its Forge sees the
 *  desktop's files but holds the typing machine's keychain, and the desktop's own
 *  window already owns both ports. `remoteWindowKind.ts` decides the kinds. */
export const HOSTED_ELSEWHERE_MESSAGE =
  'This is a VS Code tunnel or SSH window, not the desktop window itself: the model starter and ' +
  'the cloud relay belong to the desktop\u2019s own Forge window, which already holds these ports. ' +
  'Run Share in that window.';

/** One `serve` command as it was attempted: the exact text the owner can paste,
 *  and whether it worked. Built by the command module with
 *  `renderTailscaleCommand` (from `tailscaleServe.ts`), so a failure message
 *  names the command that failed in the same words the dialog showed. */
export interface ServeRun {
  command: string;
  ok: boolean;
  error?: string;
}

/** What a run did.
 *
 *  - `configEdits` is the number of switches the plan asked for: without it the
 *    message could say "config.yaml updated" on a run that found the switches
 *    already right and wrote nothing — the difference the owner has to know when
 *    a share is on and a laptop still cannot connect.
 *  - `leftShared` is every TCP port `serve` still forwards that is not one of
 *    Forge's own two. Without it a `Stop sharing` that closed 8797 and 8798
 *    reads as "the computer is closed to the tailnet" on a machine where nine
 *    model ports are still forwarded, which is how an owner starts hunting a
 *    firewall rule that was never the problem.
 */
export interface ShareOutcome {
  ran: ServeRun[];
  wrote: boolean;
  configEdits: number;
  /** Ports still shared after the run, none of them Forge's. Empty when the
   *  status could not be read or nothing else is shared. */
  leftShared?: number[] | undefined;
}

/** The ports that stay shared, as one sentence — or the plain "nothing else"
 *  line when there are none, so the message never invents a list. */
function stillShared(outcome: ShareOutcome): string {
  const ports = outcome.leftShared ?? [];
  if (!ports.length) return 'Anything else this computer shares on the tailnet was left alone.';
  return (
    `This computer still shares ${ports.join(', ')} to loopback servers through Tailscale ` +
    `(${ports.length} ${ports.length === 1 ? 'share' : 'shares'} Forge did not touch).`
  );
}

/** The message after a Share run: what was written, what ran, what failed, and
 *  the one thing the owner still has to do in the admin page. */
export function describeShareResult(outcome: ShareOutcome): string {
  const failed = outcome.ran.filter((run) => !run.ok);
  const sharesOn = outcome.ran.length - failed.length;
  const parts: string[] = [];
  parts.push(
    outcome.configEdits === 0
      ? 'config.yaml needed no change: both switches were already on.'
      : outcome.wrote
        ? 'config.yaml updated: the switches above are on, comments and everything else left as they were.'
        : 'config.yaml was not written.',
  );
  if (sharesOn) {
    parts.push(
      `${sharesOn} ${sharesOn === 1 ? 'share is' : 'shares are'} on for this computer's tailnet address.`,
    );
  }
  for (const run of failed) {
    parts.push(
      `This command did not run: ${run.command} — ${run.error ?? 'unknown failure'}. Run it yourself, or run Share again.`,
    );
  }
  parts.push(
    'Now run Forge: Connect to my desktop on the laptop. ' +
      'If it cannot reach this computer, the ACL rule naming these ports is the first thing to check.',
  );
  parts.push(stillShared(outcome));
  return parts.join(' ');
}

/** The message after a Stop sharing run, same shape: what was written, how many
 *  shares are off, what failed, and what is STILL shared — the last being the
 *  part that used to be missing. */
export function describeStopResult(outcome: ShareOutcome): string {
  const failed = outcome.ran.filter((run) => !run.ok);
  const sharesOff = outcome.ran.length - failed.length;
  const parts: string[] = [];
  parts.push(
    outcome.configEdits === 0
      ? 'config.yaml needed no change: both switches were already off.'
      : outcome.wrote
        ? 'config.yaml updated: both switches are off; the blocks and their ports are left in place.'
        : 'config.yaml was not written.',
  );
  if (sharesOff) {
    parts.push(
      `${sharesOff} ${sharesOff === 1 ? 'share is' : 'shares are'} off, so a laptop can no longer reach this computer on those ports.`,
    );
  }
  for (const run of failed) {
    parts.push(`This command did not run: ${run.command} — ${run.error ?? 'unknown failure'}.`);
  }
  parts.push(stillShared(outcome));
  return parts.join(' ');
}
