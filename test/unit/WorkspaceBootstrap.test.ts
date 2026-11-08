import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * The workspace bootstrap: the session migration, the FORGE.md auto-create, and
 * — since the laptop audit's F9 — the agent note that tells a future Claude
 * Code or Codex session the agent mesh exists.
 *
 * The note is written here because this is the one place Forge is certain to
 * run in the workspace an agent will later read. These tests pin the trigger
 * itself, which is what the owner will check on the laptop: first start in a
 * new folder writes it, a second start does not write it twice, the mesh being
 * off writes nothing, and an existing file's own text survives.
 */
const logged = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showTextDocument: vi.fn(),
    createOutputChannel: () => ({
      appendLine: (line: string) => logged.lines.push(line),
      show: () => {},
      dispose: () => {},
    }),
  },
  workspace: { openTextDocument: vi.fn(), workspaceFolders: undefined },
  commands: { registerCommand: vi.fn() },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));
vi.mock('../../src/llm/ForgeInstructionsLoader', () => ({
  // The test workspace root is the only root; the real discovery also asks the
  // git extension, which this mock host does not have.
  discoverWorkspaceRepositoryRoots: async (root: string) => [root],
  ensureForgeInstructionsFile: vi.fn(() => ({ status: 'exists', path: 'FORGE.md' })),
}));

const { bootstrapWorkspace } = await import('../../src/vscode/workspaceBootstrap');
const { NOTE_INSTALLED_MARKER, NOTE_OFF_NOTICE_MARKER } =
  await import('../../src/vscode/agentMeshNoteSetup');
const { countAgentMeshSections, buildAgentMeshNote } =
  await import('../../src/agentBus/agentMeshNote');
const { SESSION_KEY_V1 } = await import('../../src/sidebar/sessionTypes');
const vscodeMock = await import('vscode');
// The four command ids `package.json` contributes, read from the modules that
// register them so this file cannot drift from what the extension really offers.
const { DESKTOP_CONNECT_COMMAND, DESKTOP_CHECK_COMMAND } =
  await import('../../src/vscode/desktopConnect');
const { DESKTOP_SHARE_COMMAND, DESKTOP_STOP_SHARING_COMMAND } =
  await import('../../src/vscode/desktopShare');

const MARKER = 'forge.migrated.sessions.v2';
const meshOn = { agent_bus: { enabled: true }, control_server: { enabled: true, port: 8799 } };
const meshOff = { agent_bus: { enabled: false } };
const infoMock = () =>
  vscodeMock.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
const warnMock = () => vscodeMock.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
const openDocMock = () =>
  vscodeMock.workspace.openTextDocument as unknown as ReturnType<typeof vi.fn>;
const showDocMock = () => vscodeMock.window.showTextDocument as unknown as ReturnType<typeof vi.fn>;

function fakeContext(failMigrationMarker = false) {
  const workspace = new Map<string, unknown>();
  return {
    workspace,
    context: {
      globalState: {
        get: vi.fn((key: string) => (key === SESSION_KEY_V1 ? { tabs: [] } : undefined)),
        update: vi.fn(),
      },
      workspaceState: {
        get: (key: string) => workspace.get(key),
        update: async (key: string, value: unknown) => {
          if (failMigrationMarker && key === MARKER) throw new Error('disk full');
          workspace.set(key, value);
        },
      },
      subscriptions: [] as { dispose(): void }[],
    } as never,
  };
}

let scratch: string;
beforeEach(() => {
  vi.clearAllMocks();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-note-'));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function read(name: string): string {
  return fs.readFileSync(path.join(scratch, name), 'utf8');
}

describe('bootstrapWorkspace session migration', () => {
  it('retires the import without copying or changing the global session', async () => {
    const { workspace, context } = fakeContext();
    await bootstrapWorkspace(context, '', meshOn as never, 'config.yaml');
    expect(workspace.has(SESSION_KEY_V1)).toBe(false);
    expect(workspace.get(MARKER)).toBe(true);
    expect((context as { globalState: { get: unknown } }).globalState.get).not.toHaveBeenCalled();
    expect(
      (context as { globalState: { update: unknown } }).globalState.update,
    ).not.toHaveBeenCalled();
  });

  it('leaves both sessions untouched if marking retirement fails', async () => {
    const { workspace, context } = fakeContext(true);
    const localSession = { conversations: [{ id: 'keep-this-chat' }] };
    workspace.set(SESSION_KEY_V1, localSession);
    await expect(bootstrapWorkspace(context, '', meshOn as never, 'config.yaml')).rejects.toThrow(
      'disk full',
    );
    expect(workspace.has(MARKER)).toBe(false);
    expect(workspace.get(SESSION_KEY_V1)).toBe(localSession);
  });

  it('preserves existing local sessions across repeated activations', async () => {
    const { workspace, context } = fakeContext();
    const localSession = { conversations: [{ id: 'local-chat' }] };
    workspace.set(SESSION_KEY_V1, localSession);
    await bootstrapWorkspace(context, '', meshOn as never, 'config.yaml');
    await bootstrapWorkspace(context, '', meshOn as never, 'config.yaml');
    expect(workspace.get(SESSION_KEY_V1)).toBe(localSession);
  });
});

describe('the agent note on workspace bootstrap', () => {
  it('writes it into a new folder on the first start, and says what it allows', async () => {
    const { workspace, context } = fakeContext();
    await bootstrapWorkspace(context, scratch, meshOn as never, 'C:/Users/x/config.yaml');

    const content = read('AGENTS.md');
    expect(countAgentMeshSections(content)).toBe(1);
    expect(content).toContain('.forge/agent-bus');
    expect(workspace.get(NOTE_INSTALLED_MARKER)).toBe(true);
    expect(
      infoMock()
        .mock.calls.map((call) => String(call[0]))
        .some((message: string) => message.includes('message, steer and stop Forge chats')),
    ).toBe(true);
  });

  /**
   * The popup must not hold activation open. This toast goes to a window that
   * may have nobody in front of it, and by the time `bootstrapWorkspace` runs
   * the control server has already bound its port and published `endpoint.json`
   * — while the sidebar provider the control server and the job tools read is
   * handed over only after this function returns. Activation parked on an
   * undismissed toast made that window answer every `forge.sh` call with
   * "Cannot read properties of undefined (reading 'getHostFacade')" until
   * somebody clicked it: an unattended window was an unusable window through
   * the mesh. Revert the fix — await the popup — and this test times out, which
   * is the stall itself, and the note is still written by then.
   */
  it('finishes activation while the agent-note popup is still open', async () => {
    const { workspace, context } = fakeContext();
    let click: ((value: string | undefined) => void) | undefined;
    infoMock().mockImplementationOnce(
      () =>
        new Promise<string | undefined>((resolve) => {
          click = resolve;
        }),
    );
    await bootstrapWorkspace(context, scratch, meshOn as never, 'config.yaml');
    // Activation returned, the note and its marker are on disk, and the popup
    // is still waiting: nothing dismissed it, and nothing was waiting on it.
    expect(typeof click).toBe('function');
    expect(read('AGENTS.md')).toContain('.forge/agent-bus');
    expect(workspace.get(NOTE_INSTALLED_MARKER)).toBe(true);
    expect(openDocMock()).not.toHaveBeenCalled();
    // The button still works: clicking it later opens the file it is about.
    click?.('Open the file');
    await vi.waitFor(() => expect(openDocMock()).toHaveBeenCalled());
    expect(openDocMock().mock.calls[0]?.[0]).toMatchObject({
      fsPath: path.join(scratch, 'AGENTS.md'),
    });
    expect(showDocMock()).toHaveBeenCalled();
  });

  /** A follow-up nobody awaits has to report its own failures: by the time the
   *  open fails the toast is gone, so a failure that only reached the log would
   *  never be seen by the person it is about. */
  it('reports a failed "Open the file" instead of swallowing it', async () => {
    const { context } = fakeContext();
    infoMock().mockImplementationOnce(
      async (_message: string, action?: string) => action, // as if it were clicked
    );
    openDocMock().mockImplementationOnce(async () => {
      throw new Error('no such file');
    });
    await bootstrapWorkspace(context, scratch, meshOn as never, 'config.yaml');
    await vi.waitFor(() =>
      expect(
        warnMock()
          .mock.calls.map((call) => String(call[0]))
          .some((message: string) => message.includes('could not open it')),
      ).toBe(true),
    );
    expect(
      warnMock()
        .mock.calls.map((call) => String(call[0]))
        .at(-1),
    ).toContain('no such file');
    expect(logged.lines.some((line) => line.includes('could not open the written note'))).toBe(
      true,
    );
  });

  it('does not write it again on the next start of the same workspace', async () => {
    const first = fakeContext();
    await bootstrapWorkspace(first.context, scratch, meshOn as never, 'config.yaml');
    const written = read('AGENTS.md');
    // The same persisted workspaceState, which is what a window reload keeps.
    const second = fakeContext();
    second.workspace.set(NOTE_INSTALLED_MARKER, true);
    vi.clearAllMocks();
    await bootstrapWorkspace(second.context, scratch, meshOn as never, 'config.yaml');
    expect(read('AGENTS.md')).toBe(written);
    expect(infoMock()).not.toHaveBeenCalled();
  });

  it('adds the section beside text the user wrote, leaving that text alone', async () => {
    const own = '# My project\nBuild with npm run ci.\nDo not touch main.\n';
    fs.writeFileSync(path.join(scratch, 'AGENTS.md'), own);
    const { context } = fakeContext();
    await bootstrapWorkspace(context, scratch, meshOn as never, 'config.yaml');
    const content = read('AGENTS.md');
    expect(content.startsWith(own)).toBe(true);
    expect(countAgentMeshSections(content)).toBe(1);
  });

  it('writes into both files when the workspace has both', async () => {
    fs.writeFileSync(path.join(scratch, 'AGENTS.md'), 'own\n');
    fs.writeFileSync(path.join(scratch, 'CLAUDE.md'), 'own2\n');
    const { context } = fakeContext();
    await bootstrapWorkspace(context, scratch, meshOn as never, 'config.yaml');
    expect(countAgentMeshSections(read('AGENTS.md'))).toBe(1);
    expect(countAgentMeshSections(read('CLAUDE.md'))).toBe(1);
  });

  it('writes nothing when the mesh is off', async () => {
    const { workspace, context } = fakeContext();
    await bootstrapWorkspace(context, scratch, meshOff as never, 'config.yaml');
    expect(fs.existsSync(path.join(scratch, 'AGENTS.md'))).toBe(false);
    expect(workspace.get(NOTE_INSTALLED_MARKER)).toBeUndefined();
  });

  it('a section left behind with the mesh off is reported once, not deleted', async () => {
    fs.writeFileSync(
      path.join(scratch, 'AGENTS.md'),
      `own\n\n${buildAgentMeshNote({
        busDir: '/bus',
        configPath: 'config.yaml',
        meshState: 'off',
      })}\n`,
    );
    // One context for both runs: a window reload keeps the same workspaceState,
    // which is what "once" has to mean here.
    const { workspace, context } = fakeContext();
    workspace.set(NOTE_INSTALLED_MARKER, true); // Forge wrote it in an earlier session
    await bootstrapWorkspace(context, scratch, meshOff as never, 'config.yaml');
    expect(countAgentMeshSections(read('AGENTS.md'))).toBe(1);
    expect(workspace.get(NOTE_OFF_NOTICE_MARKER)).toBe(true);
    await bootstrapWorkspace(context, scratch, meshOff as never, 'config.yaml');
    expect(infoMock()).toHaveBeenCalledTimes(1);
    expect(countAgentMeshSections(read('AGENTS.md'))).toBe(1);
  });

  it('a failed write is reported and leaves the workspace retryable', async () => {
    // A root that is not on disk: the read says "absent", every write fails,
    // and the marker must not be set — otherwise the note would never be tried
    // again on any later start, and a silently missing note is exactly the F9
    // problem this phase exists to fix.
    const missingRoot = path.join(scratch, 'not-on-disk');
    const { workspace, context } = fakeContext();
    await bootstrapWorkspace(context, missingRoot, meshOn as never, 'config.yaml');
    expect(workspace.get(NOTE_INSTALLED_MARKER)).toBeUndefined();
    expect(warnMock()).toHaveBeenCalledTimes(1);
  });
});

describe('the desktop bridge on workspace bootstrap', () => {
  /** The four ids package.json contributes with no `when`, so a window with no
   *  folder open lists them in its palette. They have to be registered above
   *  `bootstrapWorkspace`'s no-folder return: none of the four needs a folder —
   *  they read the machine-scoped config and its path, run the Tailscale CLI and
   *  make HTTP requests — so registering them after the return means the palette
   *  shows commands that fail with "command not found". Reverting the fix is
   *  moving the three register calls back behind that return: this test then
   *  sees an empty list, which is that bug. The keeping-up notice stays behind
   *  the return on purpose — it is not a command, and in a folderless window it
   *  would dial the desktop at activation with nobody having asked it to.
   */
  it('registers all four desktop commands in a window with no folder', async () => {
    const desktopIds = [
      DESKTOP_CONNECT_COMMAND,
      DESKTOP_SHARE_COMMAND,
      DESKTOP_STOP_SHARING_COMMAND,
      DESKTOP_CHECK_COMMAND,
    ];
    const { workspace, context } = fakeContext();
    await bootstrapWorkspace(context, '', meshOn as never, 'C:/Users/x/config.yaml');
    const registered = (
      vscodeMock.commands.registerCommand as unknown as ReturnType<typeof vi.fn>
    ).mock.calls
      .map((call) => String(call[0]))
      .filter((id) => desktopIds.includes(id));
    // Each exactly once: a window reloads and re-activates, and `bootstrapWorkspace`
    // is called again, so a second `registerCommand` of the same id is the
    // duplicate VS Code complains about.
    expect(registered.sort()).toEqual(desktopIds.slice().sort());
    // And the no-folder return still short-circuits everything after it: the
    // session migration ran, the agent note did not.
    expect(workspace.get(MARKER)).toBe(true);
    expect(workspace.get(NOTE_INSTALLED_MARKER)).toBeUndefined();
    expect(fs.existsSync(path.join(scratch, 'AGENTS.md'))).toBe(false);
  });
});
