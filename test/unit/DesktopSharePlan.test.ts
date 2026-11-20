/**
 * What `Forge: Share this computer` and `Forge: Stop sharing this computer`
 * decide (`src/vscode/desktopSharePlan.ts`; `docs/plans/V1_FINISH_PLAN.md` lane
 * 3 phase 3.3, acceptance criterion 7).
 *
 * The rules this file exists to keep true:
 *
 * - Only the two ports Forge listens on are ever shared or ever named. The
 *   control server's 8799 and Ollama's 11434 must not appear in any note, any
 *   command or any port list — a computer that shares its control port has put a
 *   loopback admin API in front of a whole tailnet, and one that shares 11434
 *   has put a daemon that answers any request with any model in front of it.
 * - The two config switches move in one plan, and the candidate config they
 *   produce has to parse, because the caller validates it BEFORE a single
 *   `serve` command runs. A created `model_starter` block needs
 *   `shared_ports` (the schema requires at least one port) and a created
 *   `cloud_relay` block needs an allowlist of models that really need a relay.
 * - Nothing is run twice, and nothing that is not Forge's is removed: a port
 *   already forwarded to the right loopback address is reported, a port
 *   forwarded elsewhere is re-pointed with a note that says so, and `Stop
 *   sharing` turns off only the shares matching its own two ports.
 *
 * No window, no file and no child process here — `DesktopShareRun.test.ts`
 * drives those. Configs go through `ForgeConfigSchema.parse` so they carry the
 * defaults `getConfig()` would have given Share, which is the state the real
 * command sees.
 *
 * Seam question 2 (`docs/plans/V1_FINISH_PLAN.md` "Rules (every lane)"): the
 * only inbound data is `serve status --json`, and it is the answer of a program
 * Forge resolved and started itself with an argv array. There is no session,
 * chat or sender to attribute it to, so "what checks it came from the right
 * place" is answered by construction here; the run test checks the outbound
 * side instead — that the commands run are the commands the owner confirmed.
 */
import { describe, it, expect } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig } from '../../src/config/types';
import {
  planShare,
  planStop,
  relayAllowlist,
  relayPort,
  starterPort,
  type ShareFacts,
} from '../../src/vscode/desktopSharePlan';
import {
  ACL_NOTE,
  HOSTED_ELSEWHERE_MESSAGE,
  describeShareResult,
  describeStopResult,
  type ServeRun,
} from '../../src/vscode/desktopShareText';
import { parseServeStatus } from '../../src/vscode/tailscaleServe';

const EXECUTABLE = 'C:/Program Files/Tailscale/tailscale.exe';

/** A desktop config as `getConfig()` gives it: parsed, defaults filled. The
 *  models are the ones a desktop with keyed cloud models has, because the
 *  created `cloud_relay` block is built from them and has to pass the relay
 *  validator. */
function desktopConfig(overrides: Record<string, unknown> = {}): ForgeConfig {
  return ForgeConfigSchema.parse({
    models: [
      // Every allowlisted cloud model needs `api_key_secret` — the relay rule and
      // the entry rule now agree, since the `xai` OAuth-file exception is gone —
      // so the fixture carries one and the allowlist rule being tested is still
      // the relay's, not the entry's.
      { name: 'grok', provider: 'openrouter', api_key_secret: 'grok-key' },
      { name: 'gpt', provider: 'openai', api_key_secret: 'openai-key' },
      { name: 'llama3:cloud', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' },
      { name: 'ollama-local', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' },
      { name: 'maya-m2', provider: 'openai-compatible', endpoint: 'http://127.0.0.1:8081/v1', api_key_secret: 'maya-key' },
    ],
    ...overrides,
  }) as ForgeConfig;
}

/** The same desktop with nothing a relay could allow: one local Ollama model and
 *  no keyed cloud model, so there is nothing for `cloud_relay` to allow and it
 *  must stay off rather than get an empty `models` list the schema refuses.
 *  (`models` cannot be empty at all — `ForgeConfigSchema` requires at least one
 *  model — so "nothing to allow" has to be spelled as a model that does not
 *  need a relay, not as no models.) */
function localOnlyDesktop(overrides: Record<string, unknown> = {}): ForgeConfig {
  return ForgeConfigSchema.parse({
    models: [{ name: 'ollama-local', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    ...overrides,
  }) as ForgeConfig;
}

/** The state a run starts from: the config, the executable to show, and what
 *  Tailscale says is already shared (`null` = never read, which the plan treats
 *  as "nothing is shared yet" because re-sharing changes nothing). */
function facts(over: Partial<ShareFacts> = {}): ShareFacts {
  return {
    config: desktopConfig(),
    executable: EXECUTABLE,
    status: null,
    statusFailure: null,
    ...over,
  };
}

/** `serve status --json` in the shape the CLI answers with, for the ports named. */
function serving(forwards: Record<number, string>): ShareFacts['status'] {
  const body = Object.fromEntries(
    Object.entries(forwards).map(([port, target]) => [port, { EnableTcp: true, TCPForward: target }]),
  );
  return parseServeStatus(JSON.stringify({ Version: 2, TCP: body }));
}

/** Every word Share would show or run, as one string, for the "never names"
 *  guard. `candidate` is deliberately NOT in it: an untouched config may carry
 *  `control_server.port: 8799` and that is not Share naming the port — Share is
 *  judged by what it says, what it runs and which ports it puts on the tailnet. */
function everythingShareSays(plan: SharePlanLike): string {
  return [
    ...plan.notes,
    ...plan.shownCommands,
    ...plan.serveArgs.map((args) => args.join(' ')),
    ...plan.ports.map(String),
    JSON.stringify(plan.configEdits),
  ].join('\n');
}

interface SharePlanLike {
  notes: string[];
  shownCommands: string[];
  serveArgs: string[][];
  ports: number[];
  configEdits: Array<{ path: string[]; value: unknown }>;
}

/** The paths a run would write, in order, so a test can read the whole write at
 *  once instead of digging through three objects. */
function editPaths(plan: SharePlanLike & { configEdits: Array<{ path: string[] }> }): string[] {
  return plan.configEdits.map((edit) => edit.path.join('.'));
}

function run(command: string, ok: boolean, error?: string): ServeRun {
  return ok ? { command, ok } : { command, ok, error };
}

describe('the state Share starts from', () => {
  it('the fixtures are configs the loader would accept', () => {
    // A fixture the schema refuses would make every test below pass for the
    // wrong reason: an empty allowlist, a missing block, a default port.
    expect(ForgeConfigSchema.safeParse(desktopConfig()).success).toBe(true);
    expect(ForgeConfigSchema.safeParse(localOnlyDesktop()).success).toBe(true);
  });

  it('the relay allowlist is the models that need a relay, and only those', () => {
    // Every kind of allowlisted cloud model needs a stored key: the old `xai`
    // exception (it could authorise from another app's OAuth file) is gone. An
    // Ollama model is allowed only when it is a `:cloud` model on a loopback
    // endpoint, because that is what `validateCloudRelayConfig` requires and a
    // block Share creates must not be the thing that makes the config invalid.
    expect(relayAllowlist(desktopConfig())).toEqual([
      'grok',
      'gpt',
      'llama3:cloud',
      'maya-m2',
    ]);
    expect(relayAllowlist(localOnlyDesktop())).toEqual([]);
  });

  it('a block that does not exist still has a port, because the tailnet has to forward something', () => {
    // The overrides go through `desktopConfig` because both blocks need fields
    // the schema requires: `shared_ports` at least one port, `models` at least
    // one name, and a relay name has to be a model that needs a relay.
    expect(starterPort(localOnlyDesktop())).toBe(8798);
    expect(relayPort(localOnlyDesktop())).toBe(8797);
    expect(starterPort(desktopConfig({ model_starter: { port: 8801, shared_ports: [8801] } }))).toBe(8801);
    expect(relayPort(desktopConfig({ cloud_relay: { port: 8811, models: ['grok'] } }))).toBe(8811);
  });
});

describe('Share this computer', () => {
  it('turns both switches on, turns control_server on with them, and shares both ports', () => {
    const plan = planShare(facts());
    expect(editPaths(plan)).toEqual(['control_server.enabled', 'model_starter', 'cloud_relay']);
    expect(plan.ports).toEqual([8798, 8797]);
    expect(plan.serveArgs).toEqual([
      ['serve', '--bg', '--tcp', '8798', 'tcp://127.0.0.1:8798'],
      ['serve', '--bg', '--tcp', '8797', 'tcp://127.0.0.1:8797'],
    ]);
    expect(plan.shownCommands[0]).toBe(
      `"${EXECUTABLE}" serve --bg --tcp 8798 tcp://127.0.0.1:8798`,
    );
    expect(plan.nothingToDo).toBe(false);
    // `model_starter.enabled` needs `control_server.enabled` — the starter
    // shares its lifecycle state and serialisation chain — so Share turns that
    // one on too and says it is loopback-only and stays unshared.
    expect(plan.notes.join(' ')).toContain('control_server is turned on as well');
    expect(plan.notes.join(' ')).toContain('loopback-only and stays unshared');
    expect(plan.notes.join(' ')).toContain('No key is written');
    // The candidate is what the caller validates before anything changes, so it
    // has to parse: this is the guarantee that a Share run never leaves a config
    // the loader would refuse, and never runs a command behind an invalid one.
    expect(ForgeConfigSchema.safeParse(plan.candidate).success).toBe(true);
    expect(plan.candidate.model_starter?.shared_ports).toEqual([8798]);
    expect(plan.candidate.cloud_relay?.models).toEqual([
      'grok',
      'gpt',
      'llama3:cloud',
      'maya-m2',
    ]);
  });

  it('a desktop with no keyed cloud models leaves the relay off and shares one port', () => {
    const plan = planShare(facts({ config: localOnlyDesktop() }));
    expect(editPaths(plan)).toEqual(['control_server.enabled', 'model_starter']);
    expect(plan.ports).toEqual([8798]);
    expect(plan.serveArgs.length).toBe(1);
    expect(plan.notes.join(' ')).toContain('cloud_relay stays off');
    expect(ForgeConfigSchema.safeParse(plan.candidate).success).toBe(true);
    expect(plan.candidate.cloud_relay).toBeUndefined();
  });

  it('a created model_starter block lists only its own port in shared_ports', () => {
    // The field mirrors the Tailscale ACL by hand, and the only port this command
    // shares is the starter's own. Listing the model ports instead would promise
    // a route the tailnet does not have, and listing none is not allowed:
    // `shared_ports` requires at least one port.
    const plan = planShare(facts({ config: localOnlyDesktop() }));
    const created = plan.configEdits.find((edit) => edit.path.join('.') === 'model_starter');
    expect(created?.value).toEqual({
      enabled: true,
      port: 8798,
      shared_ports: [8798],
    });
    expect(plan.notes.join(' ')).toContain('forwarded to the model');
  });

  it('an existing cloud_relay block is switched on with the allowlist it already has', () => {
    const plan = planShare(
      facts({
        config: desktopConfig({
          control_server: { enabled: true },
          model_starter: { enabled: true, port: 8798, shared_ports: [8080] },
          cloud_relay: { enabled: false, port: 8797, models: ['grok'] },
        }),
      }),
    );
    expect(editPaths(plan)).toEqual(['cloud_relay.enabled']);
    expect(plan.notes.join(' ')).toContain('sharing the allowlist this config already lists: grok');
    expect(ForgeConfigSchema.safeParse(plan.candidate).success).toBe(true);
    expect(plan.candidate.cloud_relay?.models).toEqual(['grok']);
    expect(plan.candidate.model_starter?.shared_ports).toEqual([8080]);
  });

  it('a port already forwarded to the right loopback address is reported, not re-shared', () => {
    const plan = planShare(
      facts({
        config: desktopConfig({
          control_server: { enabled: true },
          model_starter: { enabled: true, port: 8798, shared_ports: [8798] },
          cloud_relay: { enabled: true, port: 8797, models: ['grok'] },
        }),
        status: serving({ 8798: '127.0.0.1:8798', 8797: '127.0.0.1:8797' }),
      }),
    );
    expect(plan.nothingToDo).toBe(true);
    expect(plan.serveArgs).toEqual([]);
    expect(plan.ports).toEqual([]);
    expect(plan.notes.join(' ')).toContain('8798 is already shared');
    expect(plan.notes.join(' ')).toContain('model_starter is already on');
  });

  it('a port forwarded to somewhere else is re-pointed, and the note says so', () => {
    const plan = planShare(
      facts({
        config: desktopConfig({
          control_server: { enabled: true },
          model_starter: { enabled: true, port: 8798, shared_ports: [8798] },
          cloud_relay: { enabled: true, port: 8797, models: ['grok'] },
        }),
        status: serving({ 8798: '127.0.0.1:8080' }),
      }),
    );
    expect(plan.ports).toEqual([8798, 8797]);
    expect(plan.serveArgs.length).toBe(2);
    expect(plan.notes.join(' ')).toContain('re-points it at 127.0.0.1:8798');
    // 8797 is not in the status at all: not shared yet, so it is shared, and a
    // desktop whose relay is on must have its port forwarded or a laptop hangs.
    expect(plan.ports).toContain(8797);
  });

  it('shares a port Forge did not make is noticed and left alone', () => {
    const plan = planShare(
      facts({
        status: parseServeStatus(
          '{"TCP":{"443":{"EnableTcp":true,"HTTPS":true},"8798":{"EnableTcp":true,"TCPForward":"127.0.0.1:8798"}}}',
        ),
      }),
    );
    expect(plan.notes.join(' ')).toContain('This computer also shares 443');
    expect(plan.notes.join(' ')).toContain('leaves those');
    expect(plan.serveArgs.length).toBe(1);
    expect(plan.ports).toEqual([8797]);
  });

  it('an unread tailnet shows both commands and says why, rather than assuming', () => {
    const plan = planShare(facts({ statusFailure: 'the daemon did not answer' }));
    expect(plan.serveArgs.length).toBe(2);
    expect(plan.notes.join(' ')).toContain('could not read what Tailscale already shares');
    expect(plan.notes.join(' ')).toContain('the daemon did not answer');
  });

  it('a config that puts a shared service on a port Forge uses for itself is refused', () => {
    // `tailscale serve --tcp 8798` in front of Forge's own admin API, or in
    // front of Ollama's daemon, is not serving a model: the laptop would get an
    // answer from something that is not its model. Both numbers are refused
    // before any command is shown, whichever block holds the port.
    const control = planShare(
      facts({
        config: desktopConfig({
          // A non-default control port, so the fixture is a config the schema
          // accepts and the refusal is Share's own rule, not the cross-check's.
          control_server: { enabled: true, port: 8790 },
          model_starter: { enabled: true, port: 8799, shared_ports: [8799] },
        }),
      }),
    );
    expect(control.nothingToDo).toBe(true);
    expect(control.ports).toEqual([]);
    expect(control.notes.join(' ')).toContain('a port Forge uses for itself');

    const ollama = planShare(
      facts({
        config: desktopConfig({
          control_server: { enabled: true },
          cloud_relay: { enabled: true, port: 11434, models: ['grok'] },
        }),
      }),
    );
    expect(ollama.nothingToDo).toBe(true);
    expect(ollama.ports).toEqual([]);
    expect(ollama.notes.join(' ')).toContain('a port Forge uses for itself');
  });

  it('nothing Share says, shows or runs names the control port or the Ollama daemon port', () => {
    // The security rule the owner set, as a scan over everything the command
    // could leak, across the shapes a desktop config actually comes in.
    const cases: Array<Record<string, unknown>> = [
      {},
      { control_server: { enabled: true } },
      { control_server: { enabled: true }, model_starter: { enabled: false, port: 8798, shared_ports: [8080, 8081] } },
      { control_server: { enabled: true }, cloud_relay: { enabled: false, port: 8797, models: ['grok'] } },
      { control_server: { enabled: true, port: 8790 }, model_starter: { enabled: true, port: 8798, shared_ports: [8798] } },
    ];
    for (const override of cases) {
      const plan = planShare(facts({ config: desktopConfig(override) }));
      expect(everythingShareSays(plan)).not.toMatch(/8799|11434/);
      const stopped = planStop(facts({ config: desktopConfig(override) }));
      expect(everythingShareSays(stopped)).not.toMatch(/8799|11434/);
    }
  });

  it('the ACL note is in the plan, because Forge cannot write it', () => {
    expect(ACL_NOTE).toContain('does not change the Tailscale ACL');
    expect(ACL_NOTE).toContain('Tailscale admin page');
    expect(ACL_NOTE).toContain('never signs you in');
    expect(ACL_NOTE).toContain('Tailnet Lock');
  });

  it('a tunnel or SSH window is told to run Share in the desktop window', () => {
    expect(HOSTED_ELSEWHERE_MESSAGE).toContain('tunnel or SSH window');
    expect(HOSTED_ELSEWHERE_MESSAGE).toContain('Run Share in that window');
  });
});

describe('Stop sharing this computer', () => {
  const bothOn = desktopConfig({
    control_server: { enabled: true },
    model_starter: { enabled: true, port: 8798, shared_ports: [8798] },
    cloud_relay: { enabled: true, port: 8797, models: ['grok'] },
  });

  it('turns both switches off and the two shares off, and nothing else', () => {
    const plan = planStop(
      facts({
        config: bothOn,
        status: serving({ 8798: '127.0.0.1:8798', 8797: '127.0.0.1:8797', 8080: '127.0.0.1:8080' }),
      }),
    );
    expect(editPaths(plan)).toEqual(['model_starter.enabled', 'cloud_relay.enabled']);
    expect(plan.serveArgs).toEqual([
      ['serve', '--tcp=8798', 'off'],
      ['serve', '--tcp=8797', 'off'],
    ]);
    expect(plan.ports).toEqual([8798, 8797]);
    // 8080 is somebody else's share on this machine: Stop must not reset it.
    expect(plan.serveArgs.map((args) => args.join(' ')).join(' ')).not.toContain('8080');
    expect(ForgeConfigSchema.safeParse(plan.candidate).success).toBe(true);
    expect(plan.candidate.model_starter?.port).toBe(8798);
    expect(plan.candidate.cloud_relay?.models).toEqual(['grok']);
    expect(plan.notes.join(' ')).toContain('its other settings are left as they were');
  });

  it('a share pointing at another port is left alone, with a note', () => {
    const plan = planStop(
      facts({ config: bothOn, status: serving({ 8798: '127.0.0.1:8080', 8797: '127.0.0.1:8797' }) }),
    );
    expect(plan.ports).toEqual([8797]);
    expect(plan.serveArgs).toEqual([['serve', '--tcp=8797', 'off']]);
    expect(plan.notes.join(' ')).toContain('leaves that share alone');
  });

  it('a block that does not exist is already off, so nothing is written for it', () => {
    const plan = planStop(facts({ config: localOnlyDesktop(), status: serving({ 8798: '127.0.0.1:8798' }) }));
    expect(plan.configEdits).toEqual([]);
    expect(plan.notes.join(' ')).toContain('there is no model_starter block');
    // The share is still turned off: leaving a tailnet share pointing at a port
    // nothing listens on would tell the owner the machine is shared when it is not.
    expect(plan.serveArgs).toEqual([['serve', '--tcp=8798', 'off']]);
    expect(plan.nothingToDo).toBe(false);
  });

  it('nothing to do when both switches are already off and nothing is shared', () => {
    const plan = planStop(facts({ config: localOnlyDesktop() }));
    expect(plan.nothingToDo).toBe(true);
    expect(plan.serveArgs).toEqual([]);
    expect(plan.configEdits).toEqual([]);
  });

  it('an already-off block is reported as off, not written again', () => {
    const plan = planStop(
      facts({
        config: desktopConfig({
          control_server: { enabled: true },
          model_starter: { enabled: false, port: 8798, shared_ports: [8798] },
          cloud_relay: { enabled: true, port: 8797, models: ['grok'] },
        }),
      }),
    );
    expect(editPaths(plan)).toEqual(['cloud_relay.enabled']);
    expect(plan.notes.join(' ')).toContain('model_starter was already off');
  });
});

describe('the shares Forge does not touch are named', () => {
  /** What `serve status --json` answers on this desktop: Forge's own two ports,
   *  plus the nine model ports a person shared by hand before Forge had a share
   *  of its own. They are forwards, so `parseServeStatus` puts them in
   *  `forwards`, not in `otherPorts` - and a run that touched only its own two
   *  ports used to report nothing about them, which read as "the computer is
   *  closed to the tailnet" on a machine where nine ports stay reachable. */
  const HAND_SHARED: Record<number, string> = {
    8797: '127.0.0.1:8797',
    8798: '127.0.0.1:8798',
    8070: '127.0.0.1:8070',
    8080: '127.0.0.1:8080',
    8081: '127.0.0.1:8081',
    8082: '127.0.0.1:8082',
    8083: '127.0.0.1:8083',
    8090: '127.0.0.1:8090',
    8091: '127.0.0.1:8091',
    8092: '127.0.0.1:8092',
    8094: '127.0.0.1:8094',
  };
  const NINE = '8070, 8080, 8081, 8082, 8083, 8090, 8091, 8092, 8094';
  const sharedBothOn = desktopConfig({
    control_server: { enabled: true },
    model_starter: { enabled: true, port: 8798, shared_ports: [8798] },
    cloud_relay: { enabled: true, port: 8797, models: ['grok'] },
  });

  it('Share names the nine ports it leaves alone, and touches none of them', () => {
    const plan = planShare(facts({ config: sharedBothOn, status: serving(HAND_SHARED) }));
    expect(plan.foreignShares).toEqual([
      8070, 8080, 8081, 8082, 8083, 8090, 8091, 8092, 8094,
    ]);
    expect(plan.notes.join(' ')).toContain(NINE);
    expect(plan.notes.join(' ')).toContain('leaves those 9 shares exactly as they are');
    // Both Forge ports are already shared to themselves, so there is nothing to
    // run - and the note is still there, because "nothing to run" is exactly the
    // case where the owner most needs to know what IS still shared.
    expect(plan.nothingToDo).toBe(true);
    expect(plan.serveArgs).toEqual([]);
  });

  it('Stop sharing names them too, and says they stay on', () => {
    const plan = planStop(facts({ config: sharedBothOn, status: serving(HAND_SHARED) }));
    expect(plan.foreignShares).toEqual([
      8070, 8080, 8081, 8082, 8083, 8090, 8091, 8092, 8094,
    ]);
    expect(plan.serveArgs).toEqual([
      ['serve', '--tcp=8798', 'off'],
      ['serve', '--tcp=8797', 'off'],
    ]);
    expect(plan.serveArgs.map((args) => args.join(' ')).join(' ')).not.toContain('8070');
    const note = plan.notes.join(' ');
    expect(note).toContain(NINE);
    // The whole point of the wording: turning Forge's two shares off is not
    // closing the computer, and an owner who reads it as closed goes looking for
    // a firewall rule that was never the problem.
    expect(note).toContain('leaves those 9 shares on, so a laptop can still reach them');
  });

  it('the message after a Stop run repeats what is still shared', () => {
    const message = describeStopResult({
      ran: [
        run('"C:/Program Files/Tailscale/tailscale.exe" serve --tcp=8798 off', true),
        run('"C:/Program Files/Tailscale/tailscale.exe" serve --tcp=8797 off', true),
      ],
      wrote: true,
      configEdits: 2,
      leftShared: [8070, 8080, 8081, 8082, 8083, 8090, 8091, 8092, 8094],
    });
    expect(message).toContain('2 shares are off');
    expect(message).toContain(`still shares ${NINE} to loopback servers through Tailscale`);
    expect(message).toContain('9 shares Forge did not touch');
    expect(message).not.toContain('Anything else');
  });

  it("Share's message names them too, and the plain line is used when nothing else is shared", () => {
    const shared = describeShareResult({
      ran: [run('"C:/Program Files/Tailscale/tailscale.exe" serve --bg --tcp 8798 tcp://127.0.0.1:8798', true)],
      wrote: true,
      configEdits: 3,
      leftShared: [8070, 8094],
    });
    expect(shared).toContain('still shares 8070, 8094');
    expect(shared).toContain('2 shares Forge did not touch');
    const plain = describeShareResult({ ran: [], wrote: true, configEdits: 3 });
    expect(plain).toContain('Anything else this computer shares on the tailnet was left alone');
  });

  it('an unread tailnet invents no list', () => {
    // `serve status --json` that could not be read is reported as such, and
    // Forge must not claim a list of ports it never saw.
    const plan = planShare(facts({ config: sharedBothOn, statusFailure: 'the daemon did not answer' }));
    expect(plan.foreignShares).toEqual([]);
    expect(plan.notes.join(' ')).not.toContain('8070');
  });
});

describe('the messages after a run', () => {
  const shared = '"C:/Program Files/Tailscale/tailscale.exe" serve --bg --tcp 8798 tcp://127.0.0.1:8798';
  const relay = '"C:/Program Files/Tailscale/tailscale.exe" serve --bg --tcp 8797 tcp://127.0.0.1:8797';

  it('says what was written, how many shares are on, and names a failed command verbatim', () => {
    const message = describeShareResult({
      ran: [run(shared, true), run(relay, false, 'spawn ECONNREFUSED')],
      wrote: true,
      configEdits: 3,
    });
    expect(message).toContain('config.yaml updated');
    expect(message).toContain('1 share is on');
    // The ledger's half-applied row: one port shared, the other not, and the
    // owner needs the exact line to paste, in the same words the dialog showed.
    expect(message).toContain(`This command did not run: ${relay} — spawn ECONNREFUSED`);
    expect(message).toContain('Connect to my desktop on the laptop');
    expect(message).toContain('ACL rule');
  });

  it('does not say anything was written when the switches were already right', () => {
    const message = describeShareResult({ ran: [run(shared, true)], wrote: false, configEdits: 0 });
    expect(message).toContain('config.yaml needed no change');
    expect(message).toContain('already on');
    expect(message).not.toContain('was not written');
  });

  it('says what a Stop run turned off, and that everything else was left alone', () => {
    const message = describeStopResult({
      ran: [run(shared, true), run(relay, true)],
      wrote: true,
      configEdits: 2,
    });
    expect(message).toContain('both switches are off');
    expect(message).toContain('2 shares are off');
    expect(message).toContain('was left alone');
    const nothing = describeStopResult({ ran: [], wrote: false, configEdits: 0 });
    expect(nothing).toContain('both switches were already off');
  });
});
