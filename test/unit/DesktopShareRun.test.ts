/**
 * The two desktop commands run end to end (`src/vscode/desktopShare.ts`;
 * `docs/plans/V1_FINISH_PLAN.md` lane 3 phase 3.3, acceptance criterion 7).
 *
 * What is being proven here is the order and the consent, not the decisions
 * (those are `DesktopSharePlan.test.ts`):
 *
 * - **The commands are shown before anything runs, and run only after the owner
 *   confirms.** A cancellation leaves the file byte-for-byte as it was and runs
 *   nothing but the read of `serve status --json`.
 * - **The argv the injected runner receives is the text the dialog showed**, in
 *   the same order — so what Forge runs cannot drift from what the owner
 *   confirmed. That is the outbound half of seam question 2; the inbound half
 *   (the tailnet status) has no session, chat or sender to attribute it to: it
 *   is the stdout of an executable Forge resolved with `findTailscaleInstall`
 *   and started with an argv array, never a shell string.
 * - **A tunnel or SSH window does nothing at all** — no read of the config, no
 *   command, no dialog, no write — while `wsl`, a container and a plain local
 *   window all proceed. The guard is `remoteWindowKind.ts`, and it must not be
 *   wider than the two kinds where a second computer is typing at this
 *   machine's own Forge window.
 * - **Nothing is touched before the candidate config has been validated**, so an
 *   invalid config never leaves a share behind, and **a window closing mid-run
 *   cuts the child process** rather than letting it apply tailnet changes nobody
 *   asked for any more.
 *
 * `tailscale` is never run: the CLI is injected (the lane rule), and the temp
 * folder is the only config file this file touches.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as YAML from 'yaml';
import {
  DESKTOP_SHARE_COMMAND,
  DESKTOP_STOP_SHARING_COMMAND,
  registerDesktopShareCommands,
  runCommand,
  type DesktopShareDeps,
} from '../../src/vscode/desktopShare';
import { HOSTED_ELSEWHERE_MESSAGE } from '../../src/vscode/desktopShareText';
import { logger } from '../../src/util/logger';

const ui = vi.hoisted(() => ({
  /** Palette commands the module under test registered, by command id. */
  handlers: {} as Record<string, () => Promise<unknown>>,
  /** Every modal message shown, with the detail line under it and its buttons. */
  dialogs: [] as Array<{ message: string; detail: string; actions: string[] }>,
  errors: [] as string[],
  /** The button answer for the next dialog; `undefined` is a cancellation. */
  answer: undefined as string | undefined,
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (id: string, fn: unknown) => {
      ui.handlers[id] = fn as () => Promise<unknown>;
      return { dispose(): void {} };
    },
  },
  window: {
    // `util/logger.ts` creates its output channel at import time.
    createOutputChannel: () => ({
      appendLine: () => {},
      append: () => {},
      clear: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
    showInformationMessage: async (
      message: string,
      options: { detail?: string } | undefined,
      ...actions: string[]
    ) => {
      ui.dialogs.push({ message, detail: options?.detail ?? '', actions });
      return ui.answer;
    },
    showErrorMessage: async (message: string) => {
      ui.errors.push(message);
    },
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
  },
  // `remoteWindowKind.ts` reads `vscode.env.remoteName`; the test alias is a
  // plain object, so a test can say which kind of window this is.
  env: { remoteName: undefined as string | undefined, appName: 'Forge' },
}));

const vscodeMock = await import('vscode');
const env = vscodeMock.env as { remoteName?: string };

/** A desktop `config.yaml` written by a person: the comments and the tuned
 *  `sampling` block are the owner's, and a Share run must leave them in place.
 *  Nothing is on yet — no `model_starter`, no `cloud_relay`, no `control_server`. */
const FRESH = `# Hand-built desktop config. These comments must survive Share.
active_model: grok
llama_server: {}
models:
  # tuned by hand on 2026-10-20
  - name: grok
    provider: xai
    api_key_secret: xai-key
    sampling: { temperature: 0.3 }
  - name: llama3:cloud
    provider: ollama
    endpoint: http://127.0.0.1:11434
`;

/** The same desktop with both switches already on, so a run has nothing to
 *  write and must not rewrite the file just because it was asked to. */
const BOTH_ON = `# Both services already on.
active_model: grok
control_server:
  enabled: true
model_starter:
  enabled: true
  port: 8798
  shared_ports: [8798]
cloud_relay:
  enabled: true
  port: 8797
  models: [grok]
models:
  - name: grok
    provider: xai
    api_key_secret: xai-key
`;

/** `model_starter.enabled` with `control_server` off: the pair the schema
 *  refuses, and the case that has to be caught before any command runs. */
const STARTER_WITHOUT_CONTROL = `active_model: grok
model_starter:
  enabled: true
  port: 8798
  shared_ports: [8080]
models:
  - name: grok
    provider: xai
    api_key_secret: xai-key
`;

const EXECUTABLE = 'C:/Program Files/Tailscale/tailscale.exe';
const QUOTED = `"${EXECUTABLE}"`;
/** The argv the injected runner records, as the string the dialog shows it in
 *  minus the executable: `runTailscale` is handed the argv, not the path, so
 *  comparing recorded calls against the dialog text needs one of the two forms
 *  spelled out. `QUOTED + ' ' + SHARE_8798` is what the owner sees. */
const STATUS = 'serve status --json';
const SHARE_8798 = 'serve --bg --tcp 8798 tcp://127.0.0.1:8798';
const SHARE_8797 = 'serve --bg --tcp 8797 tcp://127.0.0.1:8797';
const OFF_8798 = 'serve --tcp=8798 off';
const OFF_8797 = 'serve --tcp=8797 off';

interface Harness {
  configPath: string;
  /** Every `tailscale` call, as its argv joined with spaces. */
  calls: string[];
  /** The signals the calls were handed, so a test can see an abort arrive. */
  signals: Array<AbortSignal | undefined>;
  bytes(): string;
  parsed(): Record<string, unknown>;
  /** Run one of the two commands through the registration path, so the run uses
   *  the window's own abort controller. */
  run(which: 'share' | 'stop'): Promise<string>;
  /** Dispose everything the registration pushed, as a window closing would. */
  closeWindow(): void;
}

const tempDirs: string[] = [];

/** A desktop whose tailnet state is `forwards` (port → target), with the
 *  `serve` changes recorded and answered as successes unless `failFirst` says the
 *  daemon refuses the first one. */
function harness(
  seed: string,
  options: {
    forwards?: Record<number, string>;
    answer?: string;
    failFirst?: string;
    /** Resolve the first `serve` change only when its signal aborts, which is
     *  what a real child process does when the window closes. */
    waitUntilAborted?: boolean;
    /** What `getConfig()` returns, when it must differ from the bytes on disk:
     *  the writer re-reads the file itself, so a test can hold the plan valid
     *  and still make the write fail. */
    getConfigFrom?: string;
    remoteName?: string;
  } = {},
): Harness {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-share-'));
  tempDirs.push(directory);
  const configPath = path.join(directory, 'config.yaml');
  fs.writeFileSync(configPath, seed, 'utf8');
  const calls: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const context: { subscriptions: Array<{ dispose(): void }> } = { subscriptions: [] };
  let changes = 0;
  // What the confirmed changes did to the tailnet, so `serve status --json` on a
  // later run answers as the real CLI would: a Share run that shared 8798 is
  // followed by a `Stop sharing` that sees 8798 shared. A status that never
  // moved would let the round trip pass without either command being real.
  const applied = new Map<string, string>();
  const applyChange = (args: string[]): void => {
    const port = args[1].startsWith('--tcp=') ? args[1].slice(6) : args[3];
    if (!port) return;
    if (args[1] === '--bg') applied.set(port, `127.0.0.1:${port}`);
    else applied.delete(port);
  };
  const runTailscale = (args: string[], signal?: AbortSignal): Promise<string> => {
    calls.push(args.join(' '));
    signals.push(signal);
    if (args[0] === 'serve' && args[1] === 'status') {
      const merged: Record<string, string> = { ...(options.forwards ?? {}) };
      for (const [port, target] of applied) merged[port] = target;
      return Promise.resolve(
        JSON.stringify({
          Version: 2,
          TCP: Object.fromEntries(
            Object.entries(merged).map(([port, target]) => [
              port,
              { EnableTcp: true, TCPForward: target },
            ]),
          ),
        }),
      );
    }
    changes += 1;
    if (options.waitUntilAborted && changes === 1) {
      return new Promise<string>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted by this window closing'));
        signal?.addEventListener('abort', () =>
          reject(new Error('aborted by this window closing')),
        );
      });
    }
    if (options.failFirst && changes === 1) return Promise.reject(new Error(options.failFirst));
    applyChange(args);
    return Promise.resolve('share applied');
  };
  let getConfigCalls = 0;
  const deps: DesktopShareDeps = {
    getConfig: () => {
      getConfigCalls += 1;
      return YAML.parse(options.getConfigFrom ?? fs.readFileSync(configPath, 'utf8')) as never;
    },
    getConfigPath: () => configPath,
    runTailscale,
    tailscaleExecutable: () => EXECUTABLE,
  };
  registerDesktopShareCommands(context as never, deps);
  void getConfigCalls;
  return {
    configPath,
    calls,
    signals,
    bytes: () => fs.readFileSync(configPath, 'utf8'),
    parsed: () => YAML.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>,
    async run(which) {
      const handler = ui.handlers[which === 'share' ? DESKTOP_SHARE_COMMAND : DESKTOP_STOP_SHARING_COMMAND];
      return String(await handler());
    },
    closeWindow() {
      for (const subscription of context.subscriptions.splice(0)) subscription.dispose();
    },
  };
}

function serveChanges(calls: string[]): string[] {
  return calls.filter((call) => !call.includes('status --json'));
}

beforeEach(() => {
  ui.handlers = {};
  ui.dialogs.length = 0;
  ui.errors.length = 0;
  ui.answer = undefined;
  env.remoteName = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    // `rmSync`, not `await fs.rm(...)`: this Node version gives `fs.rm` without
    // a callback as a callback-API call, so an awaited `fs.rm` throws later as
    // an uncaught "callback is not a function" and leaves the folder behind for
    // `test/support/tempGuard.setup.ts` to report as a temp leak.
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});

describe('the window the command runs in', () => {
  it('a tunnel or SSH window reads nothing, runs nothing and writes nothing', async () => {
    for (const kind of ['tunnel', 'ssh-remote']) {
      const desktop = harness(FRESH, { remoteName: kind });
      env.remoteName = kind;
      const message = await desktop.run('share');
      expect(message).toContain('tunnel or SSH window');
      expect(message).toContain('Run Share in that window');
      // Not even the config is read: the desktop's own window owns these ports,
      // so this window has no business deciding what its switches say.
      expect(desktop.calls).toEqual([]);
      expect(ui.dialogs.length).toBe(0);
      expect(desktop.bytes()).toBe(FRESH);
      expect(message).toBe(HOSTED_ELSEWHERE_MESSAGE);
    }
  });

  it('a WSL, container or plain window keeps its own services and proceeds', async () => {
    // `vscode.env.remoteName` is set for EVERY remote kind. A guard that fired
    // on all of them would take Share away from WSL and container users, whose
    // keychain and ports ARE this computer's (`remoteWindowKind.ts`).
    for (const kind of [undefined, 'wsl', 'dev-container', 'codespaces']) {
      ui.dialogs.length = 0;
      const desktop = harness(FRESH);
      env.remoteName = kind;
      const message = await desktop.run('share');
      // The tailnet was read and the owner was asked to confirm: this window is
      // the one that owns these ports.
      expect(desktop.calls).toEqual([STATUS]);
      expect(ui.dialogs.length).toBe(1);
      expect(message).not.toContain('Run Share in that window');
      expect(message).not.toContain(HOSTED_ELSEWHERE_MESSAGE);
    }
  });
});

describe('the consent', () => {
  it('shows the exact commands and the ACL warning before anything runs', async () => {
    ui.answer = 'Share';
    const desktop = harness(FRESH);
    await desktop.run('share');
    const dialog = ui.dialogs[0];
    expect(dialog.message).toContain(`${QUOTED} ${SHARE_8798}`);
    expect(dialog.message).toContain(`${QUOTED} ${SHARE_8797}`);
    expect(dialog.message).toContain('Tailscale admin page');
    expect(dialog.message).toContain('Tailnet Lock');
    expect(dialog.detail).toContain('8798');
    expect(dialog.actions).toEqual(['Share']);
    // The argv the runner received is the text the dialog showed, in the order
    // it showed it: this is what makes "shown before run" more than a claim
    // about the dialog.
    expect(serveChanges(desktop.calls)).toEqual([SHARE_8798, SHARE_8797]);
  });

  it('a cancellation leaves the file exactly as it was and runs no change', async () => {
    ui.answer = undefined;
    const desktop = harness(FRESH);
    const message = await desktop.run('share');
    expect(message).toContain('Cancelled');
    expect(message).toContain('nothing was run and nothing was written');
    // Only the read happened: `serve status --json`, nothing that changes.
    expect(desktop.calls).toEqual([STATUS]);
    expect(desktop.bytes()).toBe(FRESH);
  });

  it('a config that would come back invalid is refused before any change runs', async () => {
    // `model_starter.enabled` needs `control_server.enabled`, and here the
    // starter is already on, so Share cannot turn the other one on for you: the
    // run has to stop before a single `serve` command, not after one.
    ui.answer = 'Share';
    const desktop = harness(STARTER_WITHOUT_CONTROL);
    const message = await desktop.run('share');
    expect(message).toContain('Nothing was run and nothing was written');
    expect(message).toContain('control_server.enabled');
    expect(desktop.calls).toEqual([STATUS]);
    expect(ui.dialogs.length).toBe(0);
    expect(desktop.bytes()).toBe(STARTER_WITHOUT_CONTROL);
  });
});

describe('a confirmed Share run', () => {
  it('writes both switches in one pass, keeps the comments, and shares both ports', async () => {
    ui.answer = 'Share';
    const desktop = harness(FRESH);
    const message = await desktop.run('share');
    const written = desktop.bytes();
    // The owner's own words, still in the file.
    expect(written).toContain('# Hand-built desktop config. These comments must survive Share.');
    expect(written).toContain('# tuned by hand on 2026-10-20');
    expect(written).toContain('sampling: { temperature: 0.3 }');
    const parsed = desktop.parsed();
    expect((parsed.model_starter as Record<string, unknown>).enabled).toBe(true);
    expect((parsed.model_starter as Record<string, unknown>).shared_ports).toEqual([8798]);
    expect((parsed.cloud_relay as Record<string, unknown>).models).toEqual([
      'grok',
      'llama3:cloud',
    ]);
    expect((parsed.control_server as Record<string, unknown>).enabled).toBe(true);
    expect(message).toContain('config.yaml updated');
    expect(message).toContain('2 shares are on');
    expect(message).toContain('Connect to my desktop');
    // The two ports Forge shares, and never the control port or Ollama's daemon.
    expect(desktop.calls.join(' ')).not.toMatch(/8799|11434/);
  });

  it('a port already shared is not re-run, and an unchanged file is not rewritten', async () => {
    // The case the owner hits the second time: both switches were on already,
    // one port is already shared, so there is one command to run and nothing to
    // write. The message must not read as a failed write, and the file must not
    // be re-serialized just because a command was run.
    ui.answer = 'Share';
    const desktop = harness(BOTH_ON, { forwards: { 8798: '127.0.0.1:8798' } });
    const message = await desktop.run('share');
    expect(desktop.bytes()).toBe(BOTH_ON);
    expect(serveChanges(desktop.calls)).toEqual([SHARE_8797]);
    expect(message).toContain('config.yaml needed no change');
    expect(message).toContain('already on');
    expect(message).toContain('1 share is on');
    expect(message).not.toContain('was not written');
  });

  it('a port forwarded to another port is re-pointed, and the note says so', async () => {
    ui.answer = 'Share';
    const desktop = harness(BOTH_ON, { forwards: { 8798: '127.0.0.1:8080' } });
    const message = await desktop.run('share');
    expect(ui.dialogs[0].message).toContain('re-points it at 127.0.0.1:8798');
    expect(serveChanges(desktop.calls)).toEqual([SHARE_8798, SHARE_8797]);
    expect(desktop.bytes()).toBe(BOTH_ON);
  });

  it('the first share can fail and the second still runs, and the owner gets the line to paste', async () => {
    ui.answer = 'Share';
    const desktop = harness(FRESH, { failFirst: 'spawn ECONNREFUSED' });
    const message = await desktop.run('share');
    // The ledger's half-applied row: the config is on, one port is shared, and
    // the message names the command that did not run in the words it was shown.
    expect(message).toContain(`This command did not run: ${QUOTED} serve --bg --tcp 8798`);
    expect(message).toContain('spawn ECONNREFUSED');
    expect(message).toContain('1 share is on');
    expect(serveChanges(desktop.calls).length).toBe(2);
    expect(desktop.parsed().model_starter).toBeDefined();
  });

  it('a window closing mid-command cuts the child and stops the next one', async () => {
    // Seam question 1: the AbortController in `registerDesktopShareCommands` is
    // what cancels a `serve` change, and this is the test that it actually does.
    // The faked runner resolves only when its signal aborts, which is what a real
    // `execFile` child does; the deadline is `TailscaleCli.test.ts`.
    ui.answer = 'Share';
    const desktop = harness(FRESH, { waitUntilAborted: true });
    const started = desktop.run('share');
    // The first change is in flight as soon as the status read is recorded.
    for (let waited = 0; waited < 200 && desktop.calls.length < 2; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(desktop.calls.length).toBe(2);
    desktop.closeWindow();
    const message = String(await started);
    expect(message).toContain('This command did not run');
    expect(message).toContain('cancelled by this window closing');
    // The second change was never sent to the CLI at all.
    expect(serveChanges(desktop.calls).length).toBe(1);
    expect(desktop.signals.some((signal) => signal?.aborted === true)).toBe(true);
  });

  it('a write the config writer refuses comes back as text, not as a silent rejection', async () => {
    // `updateConfigFile` throws on a file that no longer parses. A palette
    // command that rejects tells the owner nothing, so the reason has to be in
    // the message, and the file has to be left alone. `getConfigFrom` keeps the
    // plan valid — the writer re-reads the file itself, and that is the read
    // that has to fail here.
    ui.answer = 'Share';
    const broken = 'active_model: [this is not a mapping\n';
    const desktop = harness(FRESH, { getConfigFrom: FRESH });
    fs.writeFileSync(desktop.configPath, broken, 'utf8');
    const message = await desktop.run('share');
    expect(message).toContain('did not complete');
    expect(message).toContain('parse failed');
    expect(desktop.bytes()).toBe(broken);
    expect(serveChanges(desktop.calls)).toEqual([]);
  });
});

describe('Stop sharing this computer', () => {
  it('turns both switches off and both shares off, and leaves the blocks in place', async () => {
    ui.answer = 'Stop sharing';
    const desktop = harness(BOTH_ON, {
      forwards: { 8798: '127.0.0.1:8798', 8797: '127.0.0.1:8797', 8080: '127.0.0.1:8080' },
    });
    const message = await desktop.run('stop');
    expect(serveChanges(desktop.calls)).toEqual([OFF_8798, OFF_8797]);
    const parsed = desktop.parsed();
    expect((parsed.model_starter as Record<string, unknown>).enabled).toBe(false);
    expect((parsed.cloud_relay as Record<string, unknown>).enabled).toBe(false);
    // Off, not deleted: the ports and the allowlist are the owner's settings and
    // turning sharing back on should not need them rebuilt.
    expect((parsed.model_starter as Record<string, unknown>).port).toBe(8798);
    expect((parsed.cloud_relay as Record<string, unknown>).models).toEqual(['grok']);
    expect(message).toContain('both switches are off');
    expect(message).toContain('2 shares are off');
    // Somebody else's share on this machine, still there.
    expect(desktop.calls.join(' ')).not.toContain('8080');
    expect(desktop.bytes()).toContain('# Both services already on.');
  });

  it('running Share and then Stop leaves both switches off', async () => {
    ui.answer = 'Share';
    const desktop = harness(FRESH);
    await desktop.run('share');
    ui.answer = 'Stop sharing';
    const message = await desktop.run('stop');
    const parsed = desktop.parsed();
    expect((parsed.model_starter as Record<string, unknown>).enabled).toBe(false);
    expect((parsed.cloud_relay as Record<string, unknown>).enabled).toBe(false);
    expect(message).toContain('off');
    expect(desktop.calls).toContain(OFF_8798);
  });

  it('a share that is not Forge pointing at its own port is left alone', async () => {
    ui.answer = 'Stop sharing';
    const desktop = harness(BOTH_ON, {
      forwards: { 8798: '127.0.0.1:8080', 8797: '127.0.0.1:8797' },
    });
    const message = await desktop.run('stop');
    expect(ui.dialogs[0].message).toContain('leaves that share alone');
    expect(serveChanges(desktop.calls)).toEqual([OFF_8797]);
    expect(message).toContain('1 share is off');
  });

  it('Stop sharing names the nine model ports that stay shared, in the dialog and in the message', async () => {
    // The shape `serve status --json` really answers with on this desktop: Forge's
    // two ports plus nine model ports shared by hand before Forge had a share of
    // its own. Turning Forge's two off is not closing the computer, and the owner
    // has to be told that before, not after - so the ports appear in the dialog
    // that asks for confirmation and again in the message that follows.
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
    ui.answer = 'Stop sharing';
    const desktop = harness(BOTH_ON, { forwards: HAND_SHARED });
    const message = await desktop.run('stop');
    const dialog = ui.dialogs[0].message;
    expect(dialog).toContain('8070, 8080, 8081, 8082, 8083, 8090, 8091, 8092, 8094');
    expect(dialog).toContain('leaves those 9 shares on, so a laptop can still reach them');
    expect(message).toContain('2 shares are off');
    expect(message).toContain('still shares 8070, 8080');
    expect(message).toContain('Forge did not touch');
    // Only Forge's own two ports are turned off: a `serve ... off` naming a model
    // port would have closed something the owner never asked to close.
    expect(serveChanges(desktop.calls)).toEqual([OFF_8798, OFF_8797]);
    expect(desktop.calls.join(' ')).not.toContain('8070');
  });
});

describe('the registration', () => {
  it('contributes both commands to the palette and disposes the abort with the window', async () => {
    ui.answer = 'Share';
    const desktop = harness(FRESH);
    expect(Object.keys(ui.handlers).sort()).toEqual([
      DESKTOP_SHARE_COMMAND,
      DESKTOP_STOP_SHARING_COMMAND,
    ]);
    const message = await desktop.run('share');
    expect(message).toContain('config.yaml updated');
    expect(ui.errors).toEqual([]);
    desktop.closeWindow();
  });

  it('the log gets the run, so the live test can prove which commands ran', async () => {
    ui.answer = 'Share';
    const desktop = harness(FRESH);
    const line = vi.spyOn(logger, 'info').mockImplementation(() => {});
    await desktop.run('share');
    const logged = line.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('[Share] share');
    expect(logged).toContain('ran 2/2 commands');
    expect(logged).toContain('serve --bg --tcp 8798');
  });
});
