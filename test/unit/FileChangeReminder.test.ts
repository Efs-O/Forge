/**
 * The "file changed since you read it" reminder (`event_reminders.file_changed`).
 *
 * Every case in `docs/plans/EVENT_REMINDERS_PLAN.md` § "Must fire" / "Must not
 * fire", against a real temp folder and real `fs` stats. The mtimes are set with
 * `fs.utimesSync` rather than left to the clock, so a change is never missed (or
 * invented) because two writes landed inside the filesystem's timestamp
 * resolution — the plan's own requirement.
 *
 * The three message texts are pinned whole with `toBe`: they go into the model's
 * context, so a reword is a change in behaviour, not a cosmetic edit.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted, so the workspace folder is computed inside the factory —
// the same shape `ToolDispatch.test.ts` uses, and it stays inside the per-file
// temp folder the vitest setup narrows `os.tmpdir()` to.
vi.mock('vscode', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('os') as typeof import('os');
  const ws = p.join(o.tmpdir(), 'forge-file-change-reminder');
  return {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: ws } }],
      // The real call answers with `/` separators for a file inside the
      // workspace and with the absolute path for one outside it.
      asRelativePath: (value: string) =>
        value.startsWith(ws + p.sep) ? value.slice(ws.length + 1).split(p.sep).join('/') : value,
      getConfiguration: () => ({ get: () => false }),
    },
    window: {
      createOutputChannel: () => ({
        appendLine: () => undefined,
        clear: () => undefined,
        show: () => undefined,
        dispose: () => undefined,
      }),
    },
    Uri: { file: (value: string) => ({ fsPath: value }) },
  };
});

import {
  clearConversationFileReads,
  fileChangedReminderEnabledFor,
  fileChangeSource,
  noteToolCall,
  setFileChangeReminderEnabled,
  type ToolCallFacts,
} from '../../src/agent/fileChangeReminder';
import { wireMidTurnTells } from '../../src/sidebar/midTurnTellWiring';
import { MidTurnInbox } from '../../src/agent/MidTurnInbox';
import { MidTurnTellDrain } from '../../src/agent/MidTurnTellDrain';
import { ElapsedTimeNote } from '../../src/agent/elapsedTimeNote';
import { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import { ToolRegistry, type ToolPermission } from '../../src/tools/ToolRegistry';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import type { ToolFailureTracker } from '../../src/tools/StripTools';
import type { ChatMessage, ToolCall } from '../../src/llm/types';

const WS = path.join(os.tmpdir(), 'forge-file-change-reminder');
const CONV = 'conv-reminder-a';
const OTHER = 'conv-reminder-b';

/** Two fixed stamps: the whole test turns on which one the file carries. */
const THEN = new Date(1_000_000_000);
const NOW = new Date(2_000_000_000);

/** What the wiring reads: `sidebarWiring.ts` passes the same expression. */
let config: { event_reminders?: { file_changed?: boolean } } = {};

beforeEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  clearConversationFileReads();
  config = {};
  setFileChangeReminderEnabled(() => fileChangedReminderEnabledFor(config));
});

afterAll(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

function writeAt(filePath: string, content: string, at: Date): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  fs.utimesSync(filePath, at, at);
}

/** A file in the (mocked) workspace, stamped `THEN`. */
function workspaceFile(name: string, content = 'one\n'): string {
  const filePath = path.join(WS, name);
  writeAt(filePath, content, THEN);
  return filePath;
}

/** Outside the change: a rewrite plus a new stamp, which is what a test runner
 *  or an editor does, and the case the reminder exists for. */
function changeOutside(filePath: string, content = 'two\n'): void {
  fs.writeFileSync(filePath, content);
  fs.utimesSync(filePath, NOW, NOW);
}

function note(
  convId: string | undefined,
  overrides: Partial<ToolCallFacts> & { toolName: string },
): void {
  noteToolCall(convId, {
    permission: 'read',
    hasMutation: false,
    args: {},
    resultFailed: false,
    touchedPaths: [],
    ...overrides,
  });
}

const readCall = (args: Record<string, unknown>, convId: string | undefined = CONV) =>
  note(convId, { toolName: 'read_file', args });
const writeCall = (touchedPaths: string[], toolName = 'edit_file') =>
  note(CONV, { toolName, permission: 'write', hasMutation: true, touchedPaths });
const shellCall = () => note(CONV, { toolName: 'shell', permission: 'terminal' });

/** The reminder for this conversation, or `undefined` when the drain is silent. */
async function reminder(convId = CONV): Promise<string | undefined> {
  const drained = await fileChangeSource(convId);
  expect(drained.messages.length).toBeLessThanOrEqual(1);
  const message = drained.messages[0];
  return typeof message?.content === 'string' ? message.content : undefined;
}

describe('the file-change reminder', () => {
  it('names the one file that changed, in the one-path text', async () => {
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    changeOutside(file);
    expect(await reminder()).toBe(
      '[Forge] a.ts changed on disk after you last read it. Read it again before ' +
        'you edit it: old_str copied from the earlier read may no longer match.',
    );
  });

  it('fires when the file was deleted', async () => {
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    fs.rmSync(file);
    expect(await reminder()).toBe(
      '[Forge] a.ts changed on disk after you last read it. Read it again before ' +
        'you edit it: old_str copied from the earlier read may no longer match.',
    );
  });

  it('names both files a reads[] call asked for', async () => {
    const a = workspaceFile('a.ts');
    const b = workspaceFile('b.ts');
    readCall({ reads: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    changeOutside(a);
    changeOutside(b);
    expect(await reminder()).toBe(
      '[Forge] These files changed on disk after you last read them: a.ts, b.ts. ' +
        'Read them again before you edit them: old_str copied from an earlier read may no longer match.',
    );
  });

  it('names the first five and counts the rest', async () => {
    for (const name of ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts', 'f6.ts'])
      workspaceFile(name);
    readCall({
      reads: ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts', 'f6.ts'].map((pathName) => ({
        path: pathName,
      })),
    });
    for (const name of ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts', 'f6.ts'])
      changeOutside(path.join(WS, name));
    expect(await reminder()).toBe(
      '[Forge] These files changed on disk after you last read them: ' +
        'f1.ts, f2.ts, f3.ts, f4.ts, f5.ts and 1 more. Read them again before you edit them: ' +
        'old_str copied from an earlier read may no longer match.',
    );
  });

  it('fires on a new mtime at the same size', async () => {
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    fs.utimesSync(file, NOW, NOW);
    expect(await reminder()).toContain('changed on disk after you last read it');
  });

  it('fires on a new size at the same mtime', async () => {
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    fs.writeFileSync(file, 'a much longer replacement\n');
    fs.utimesSync(file, THEN, THEN);
    expect(await reminder()).toContain('changed on disk after you last read it');
  });

  it('fires for a file outside the workspace, read by absolute path', async () => {
    const outside = path.join(os.tmpdir(), 'forge-file-change-outside', 'notes.md');
    writeAt(outside, 'one\n', THEN);
    readCall({ path: outside });
    changeOutside(outside);
    const text = await reminder();
    expect(text).toBe(
      `[Forge] ${outside} changed on disk after you last read it. Read it again before ` +
        'you edit it: old_str copied from the earlier read may no longer match.',
    );
    fs.rmSync(path.dirname(outside), { recursive: true, force: true });
  });

  it('records nothing while off, so a change made before the switch-on is silent', async () => {
    config = { event_reminders: { file_changed: false } };
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    config = { event_reminders: { file_changed: true } };
    changeOutside(file);
    expect(await reminder()).toBeUndefined();
  });

  it('says nothing at a drain while off, even with the change already recorded', async () => {
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    changeOutside(file);
    config = { event_reminders: { file_changed: false } };
    expect(await reminder()).toBeUndefined();
  });
});

describe('the file-change reminder stays silent', () => {
  it('after this chat edited the file itself', async () => {
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    changeOutside(file);
    writeCall([file], 'edit_file');
    expect(await reminder()).toBeUndefined();
  });

  it('after a shell call, even when the file changed during it', async () => {
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    changeOutside(file);
    shellCall();
    expect(await reminder()).toBeUndefined();
  });

  it('after this chat moved or deleted the file, and stops tracking it', async () => {
    const moved = workspaceFile('moved.ts');
    const removed = workspaceFile('gone.ts');
    readCall({ reads: [{ path: 'moved.ts' }, { path: 'gone.ts' }] });
    fs.rmSync(moved);
    fs.rmSync(removed);
    writeCall([moved], 'move_file');
    writeCall([removed], 'delete_file');
    expect(await reminder()).toBeUndefined();
    // No longer tracked: the same path coming back with a new stamp is not reported.
    writeAt(moved, 'back again, much longer\n', NOW);
    expect(await reminder()).toBeUndefined();
  });

  it('when the tool reported the path only through beforeMutate', async () => {
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    changeOutside(file);
    // `mutationPaths` empty, the path arriving through `beforeMutate` alone: what
    // ToolDispatch collects into `touchedPaths`, which the reminder re-stats.
    writeCall([file], 'apply_code_action');
    expect(await reminder()).toBeUndefined();
  });

  it('when nothing changed', async () => {
    workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    expect(await reminder()).toBeUndefined();
  });

  it('a second time with no further change: one change fires once', async () => {
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    changeOutside(file);
    expect(await reminder()).toBeDefined();
    expect(await reminder()).toBeUndefined();
  });

  it('when file_changed is false: nothing is recorded and nothing is said', async () => {
    config = { event_reminders: { file_changed: false } };
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    changeOutside(file);
    expect(await reminder()).toBeUndefined();
    config = { event_reminders: { file_changed: true } };
    expect(await reminder()).toBeUndefined();
  });

  it('about a file this chat only wrote, never read', async () => {
    const file = path.join(WS, 'written.ts');
    writeCall([file], 'write_file');
    changeOutside(file);
    expect(await reminder()).toBeUndefined();
  });

  it('for a read_file that failed: nothing was read, so nothing is recorded', async () => {
    const file = workspaceFile('a.ts');
    note(CONV, { toolName: 'read_file', args: { path: 'a.ts' }, resultFailed: true });
    changeOutside(file);
    expect(await reminder()).toBeUndefined();
  });

  it('when there is no conversation id', async () => {
    const file = workspaceFile('a.ts');
    // Passed straight to `note`: a `undefined` argument would hit the helper's
    // default conversation id instead of the missing one this case is about.
    note(undefined, { toolName: 'read_file', args: { path: 'a.ts' } });
    changeOutside(file);
    expect(await reminder(CONV)).toBeUndefined();
  });

  it('for a cleared conversation, and still not for another one', async () => {
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' }, CONV);
    readCall({ path: 'a.ts' }, OTHER);
    clearConversationFileReads(CONV);
    changeOutside(file);
    expect(await reminder(CONV)).toBeUndefined();
    expect(await reminder(OTHER)).toBeDefined();
  });

  const itWin32 = process.platform === 'win32' ? it : it.skip;
  itWin32('treats A.ts read and a.ts written as the same file', async () => {
    const file = workspaceFile('a.ts');
    readCall({ path: 'A.ts' });
    changeOutside(file);
    writeCall([path.join(WS, 'a.ts')], 'write_file');
    expect(await reminder()).toBeUndefined();
  });
});

describe('the wiring', () => {
  /** `sidebarWiring.ts`'s own getter expression, fed the three config shapes. */
  function wire(): { tellDrain: MidTurnTellDrain; post: ReturnType<typeof vi.fn> } {
    const tellDrain = new MidTurnTellDrain();
    const post = vi.fn();
    const setMidTurnTells = vi.fn();
    wireMidTurnTells({
      tellDrain,
      midTurnInbox: new MidTurnInbox(),
      elapsedTimeNote: new ElapsedTimeNote(() => undefined),
      post,
      setMidTurnTells,
    });
    return { tellDrain, post };
  }

  async function drainAfterAnOutsideChange(tellDrain: MidTurnTellDrain): Promise<ChatMessage[]> {
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    changeOutside(file);
    const drained = await tellDrain.drain(CONV);
    void file;
    return drained.messages;
  }

  it('registers the file-change source and delivers the reminder flagged internal and midTurn', async () => {
    config = { event_reminders: { file_changed: true } };
    const { tellDrain } = wire();
    const messages = await drainAfterAnOutsideChange(tellDrain);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'user',
      internal: true,
      midTurn: true,
      content:
        '[Forge] a.ts changed on disk after you last read it. Read it again before ' +
        'you edit it: old_str copied from the earlier read may no longer match.',
    });
  });

  it('fires with the config block absent: the reminder is on by default', async () => {
    config = {};
    const { tellDrain } = wire();
    expect(await drainAfterAnOutsideChange(tellDrain)).toHaveLength(1);
  });

  it('returns nothing when file_changed is false', async () => {
    config = { event_reminders: { file_changed: false } };
    const { tellDrain } = wire();
    expect(await drainAfterAnOutsideChange(tellDrain)).toHaveLength(0);
  });

  it('reads the config at every drain, so switching off needs no re-registration', async () => {
    config = {};
    const { tellDrain } = wire();
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    changeOutside(file);
    config = { event_reminders: { file_changed: false } };
    expect((await tellDrain.drain(CONV)).messages).toHaveLength(0);
    config = {};
    // The change is still recorded, so switching back on reports it once.
    expect((await tellDrain.drain(CONV)).messages).toHaveLength(1);
  });

  it('treats an absent block and file_changed: true as on, and false as off', () => {
    expect(fileChangedReminderEnabledFor(undefined)).toBe(true);
    expect(fileChangedReminderEnabledFor({})).toBe(true);
    expect(fileChangedReminderEnabledFor({ event_reminders: {} })).toBe(true);
    expect(fileChangedReminderEnabledFor({ event_reminders: { file_changed: true } })).toBe(true);
    expect(fileChangedReminderEnabledFor({ event_reminders: { file_changed: false } })).toBe(false);
  });
});

describe('the dispatch wiring', () => {
  const allowed = new Set<ToolPermission>(['read', 'write']);

  function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
    return { id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  }

  function makeDispatch(registry: ToolRegistry): ToolDispatch {
    const checkpoints = {
      snapshotBefore: vi.fn(),
      readSnapshotContent: vi.fn(),
    } as unknown as CheckpointStack;
    const codeLens = { markPending: vi.fn() } as unknown as KeepUndoCodeLensProvider;
    const failureTracker = {
      recordNativeParseFailure: vi.fn(),
      reset: vi.fn(),
      shouldStrip: vi.fn().mockReturnValue(false),
    } as unknown as ToolFailureTracker;
    const diffDecorations = { apply: vi.fn() } as unknown as DiffDecorations;
    return new ToolDispatch(
      registry,
      checkpoints,
      codeLens,
      failureTracker,
      vi.fn(),
      vi.fn().mockResolvedValue('approved'),
      diffDecorations,
    );
  }

  it('counts a path a tool reports only through beforeMutate as this chat writing it', async () => {
    const file = workspaceFile('a.ts');
    readCall({ path: 'a.ts' });
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        type: 'function',
        function: {
          name: 'helper_writer',
          description: 'Rewrites a file it was not asked for by name.',
          parameters: { type: 'object' },
        },
      },
      permission: 'write',
      // Declares no path up front: the tool names the file only as it writes it.
      mutation: { paths: () => [] },
      handler: async (_args, context) => {
        context?.beforeMutate?.([file]);
        changeOutside(file, 'rewritten by the helper\n');
        return 'ok';
      },
    });
    const messages: ChatMessage[] = [];
    await makeDispatch(registry).dispatch(
      [makeToolCall('helper_writer', {})],
      allowed,
      messages,
      CONV,
    );
    expect(messages[0]?.content).toBe('ok');
    // If `beforeMutate` were not collected, this drain would blame the model for
    // a change its own tool made.
    expect(await reminder()).toBeUndefined();
  });
});
