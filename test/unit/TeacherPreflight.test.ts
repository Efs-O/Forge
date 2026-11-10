/**
 * Preflight for the supervising chat's basic commands. Add any new teacher
 * command failure here first so the tool path is checked before another run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyShellCommand } from '../../src/tools/shellPolicy';
import { parseAgentMessageOptions } from '../../src/backend/agentMessageOptions';
import {
  formatPeerSection,
  matchPeerWindow,
  peerWindowListLabel,
  windowLabel,
  type PeerWindow,
} from '../../src/tools/messageChatPeers';
import { makeReadFileTool } from '../../src/tools/readFileTool';
import { workspace } from '../support/vscode';
import * as vscode from '../support/vscode';
import { resolveRipgrep } from '../../src/tools/RipgrepResolver';
import { resolveLiveAppRoot } from '../live/liveModelHarness';

const shell = {
  home: 'C:/Users/efso office',
  platform: 'win32' as const,
  cwd: 'N:/vs code apps/Forge',
};
const ownerOnly = ['c:/users/efso office/.forge'];
const allowedBash = [
  'ls -t "C:/Users/efso office/.forge/sessions" | head -3; f=$(ls -t "C:/Users/efso office/.forge/sessions"/*.jsonl | head -1); echo "FILE: $f"; tail -c 1200 "$f"',
  'f=$(ls -t "C:/Users/efso office/.forge/sessions"/*.jsonl | head -1); tail -c 1200 "$f"',
  'n=$(wc -l < "C:/Users/efso office/.forge/sessions/x.jsonl")',
  'f=`ls "C:/Users/efso office/.forge/sessions"`',
  'x=1; y=abc',
  'tail -n 40 "C:/Users/efso office/.forge/sessions/x.jsonl" | grep -c tool_calls',
];

let previousWorkspace = workspace.workspaceFolders;
let previousAppRoot = vscode.env.appRoot;
let tempWorkspace: string | undefined;

const bundledRg = resolveRipgrep(resolveLiveAppRoot());
const realRg = fs.existsSync(bundledRg.command) ? bundledRg : undefined;

afterEach(() => {
  workspace.workspaceFolders = previousWorkspace;
  vscode.env.appRoot = previousAppRoot;
  if (tempWorkspace) fs.rmSync(tempWorkspace, { recursive: true, force: true });
  tempWorkspace = undefined;
});

describe('teacher preflight', () => {
  it('keeps agent-bus new_chat fields unable to switch Clanker on', () => {
    expect(
      parseAgentMessageOptions({
        from: 'codex',
        new_chat: true,
        clanker: true,
      }),
    ).toEqual({ newChat: true });
  });

  it.each(allowedBash)('allows the supervising chat bash command: %s', (command) => {
    expect(classifyShellCommand(command, 'bash', shell).classification).toBe('read_only');
    expect(classifyShellCommand(command, 'bash', { ...shell, ownerOnly }).classification).toBe(
      'read_only',
    );
  });

  it('allows the supervising chat PowerShell session-log reads', () => {
    const commands = [
      'Get-ChildItem "C:/Users/efso office/.forge/sessions" -Filter *.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 1',
      'Get-Content -Tail 40 "C:/Users/efso office/.forge/sessions/x.jsonl"',
      '$f = Get-ChildItem "C:/Users/efso office/.forge/sessions" -Filter *.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 1',
    ];
    for (const command of commands) {
      expect(classifyShellCommand(command, 'pwsh', shell).classification).toBe('read_only');
      expect(classifyShellCommand(command, 'pwsh', { ...shell, ownerOnly }).classification).toBe(
        'read_only',
      );
    }
  });

  it('round-trips list and refusal labels for every responding peer window', () => {
    const peers: PeerWindow[] = [
      {
        windowId: 'eff97bba-2222-4222-8222-222222222222',
        url: 'http://127.0.0.1:1',
        token: 'a'.repeat(32),
        workspace: 'N:/vs code apps/Qwen_fine_tuning',
        models: [],
        chats: [],
      },
      {
        windowId: '12345678-3333-4333-8333-333333333333',
        url: 'http://127.0.0.1:1',
        token: 'b'.repeat(32),
        workspace: 'N:/other/Student',
        models: [],
        chats: [],
      },
    ];
    const listed = formatPeerSection(peers, []);
    expect(listed).toBe(
      '\nOther windows:\nQwen_fine_tuning (N:/vs code apps/Qwen_fine_tuning) — 0 chat(s):\n' +
        'Student (N:/other/Student) — 0 chat(s):\n' +
        'Address a chat in another window by its id; `#N` is this window only.',
    );
    const labels = listed
      .split('\n')
      .filter((line) => line.endsWith(' — 0 chat(s):'))
      .map((line) => line.slice(0, -' — 0 chat(s):'.length));
    expect(labels).toEqual(peers.map(peerWindowListLabel));
    for (const [index, peer] of peers.entries()) {
      expect(matchPeerWindow(peers, labels[index] ?? '')).toEqual({ peer });
      expect(matchPeerWindow(peers, windowLabel(peer))).toEqual({ peer });
    }
    const qwen = peers[0]!;
    for (const label of [
      'Qwen_fine_tuning',
      'n:\\vs code apps\\Qwen_fine_tuning',
      'N:/vs code apps/Qwen_fine_tuning',
      'Qwen_fine_tuning (n:\\vs code apps\\Qwen_fine_tuning)',
      'Qwen_fine_tuning (eff97bba)',
      'eff97bba',
      qwen.windowId,
    ])
      expect(matchPeerWindow(peers, label)).toEqual({ peer: qwen });
    expect(matchPeerWindow(peers, 'missing')).toEqual({
      refusal:
        'Error: no other Forge window matches "missing"; the windows here are Qwen_fine_tuning (eff97bba), Student (12345678). Nothing was created and no counter was used.',
    });
    const duplicate = {
      ...peers[1]!,
      windowId: '87654321-4444-4444-8444-444444444444',
      workspace: 'N:/else/Student',
    };
    expect(matchPeerWindow([peers[1]!, duplicate], 'Student')).toEqual({
      refusal:
        'Error: "Student" matches more than one window (Student (12345678), Student (87654321)); name the folder in full or the window id. Nothing was created and no counter was used.',
    });
  });

  it.skipIf(realRg === undefined)('resolves read_file against the workspace and suggests a unique real ripgrep match', async () => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-teacher-preflight-'));
    previousWorkspace = workspace.workspaceFolders;
    previousAppRoot = vscode.env.appRoot;
    vscode.env.appRoot = resolveLiveAppRoot();
    workspace.workspaceFolders = [{ uri: { fsPath: tempWorkspace } }];
    const actual = path.join(tempWorkspace, 'scripts', 'lab-sync', 'logscan.py');
    fs.mkdirSync(path.dirname(actual), { recursive: true });
    fs.writeFileSync(actual, 'print("ok")\n');
    const read = makeReadFileTool();
    const context = { signal: new AbortController().signal } as never;
    await expect(read.handler({ path: 'scripts/lab-sync/logscan.py' }, context)).resolves.toBe(
      'print("ok")\n',
    );
    const missingPath = path.join(tempWorkspace, 'scripts', 'session-scan', 'logscan.py');
    const expected =
      `read_file: nothing exists there. "scripts/session-scan/logscan.py" resolved against the workspace root ${tempWorkspace}. ` +
      `ENOENT: no such file or directory, stat '${missingPath}' ` +
      'Did you mean "scripts/lab-sync/logscan.py"? ' +
      'The workspace root is often not the project root, so a path that looks right for the project can still miss. Use find_files to locate it before retrying.';
    const missingRead = await read
      .handler({ path: 'scripts/session-scan/logscan.py' }, context)
      .then(
        () => {
          throw new Error('Expected read_file to reject a missing path.');
        },
        (error: unknown) => error as Error,
      );
    expect(missingRead.message).toBe(expected);
  });
});
