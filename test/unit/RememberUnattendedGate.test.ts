import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import { answerBeforeCard } from '../../src/sidebar/approvalAutoAnswer';
import { createChatRuleApproval } from '../../src/sidebar/chatApprovalRules';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import { MemoryStore, attachMemoryStore } from '../../src/memory/memoryStore';
import { makeRememberTool } from '../../src/tools/memoryTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import type { ToolFailureTracker } from '../../src/tools/StripTools';

// ToolDispatch builds its output channel and resolves paths through vscode at
// import time; the same minimal shape the dispatch harness runs on.
vi.mock('vscode', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('os') as typeof import('os');
  const ws = p.join(o.tmpdir(), 'forge-remember-gate-workspace');
  return {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: ws } }],
      openTextDocument: vi.fn().mockResolvedValue({}),
      asRelativePath: vi.fn((s: string) => s),
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
    },
    window: {
      showTextDocument: vi.fn().mockResolvedValue(undefined),
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        clear: vi.fn(),
        show: vi.fn(),
        dispose: vi.fn(),
      })),
    },
    Uri: { file: vi.fn((s: string) => ({ fsPath: s })) },
  };
});

const ALLOWED = new Set(['read']) as never;

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call-${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** The refusal an unattended `remember` gets, in the exact words the model reads. */
function expectedRefusal(allowPath: string): string {
  return (
    'unattended: approval key denied by policy: "remember". ' +
    `Add tool:remember to ${allowPath} in ~/.forge/policy.yaml. ` +
    'The memory was NOT saved. ' +
    'Use this instead: carry on without it, and list the memory you wanted to save ' +
    '(its key and its text) in your final report. ' +
    'This refusal ends nothing else: continue the run.'
  );
}

let root: string;
let state: vscode.Memento;
let store: MemoryStore;
let registry: ToolRegistry;
let checkpoints: CheckpointStack;
let failureTracker: ToolFailureTracker;
let post: ReturnType<typeof vi.fn>;
let requestApproval: ReturnType<typeof vi.fn>;

function dispatchWith(config: unknown, clankerMode?: () => boolean): ToolDispatch {
  const chatRules = createChatRuleApproval({
    getConfig: () => config as never,
    recordAutoGate: vi.fn(),
    ...(clankerMode ? { clankerMode } : {}),
  });
  return new ToolDispatch(
    registry,
    checkpoints,
    { markPending: vi.fn(), clearPending: vi.fn() } as unknown as KeepUndoCodeLensProvider,
    failureTracker,
    post,
    requestApproval,
    { apply: vi.fn() } as unknown as DiffDecorations,
    chatRules,
  );
}

async function runRemember(dispatch: ToolDispatch, conversationId: string): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  await dispatch.dispatch(
    [makeToolCall('remember', { key: 'lane-note', value: 'a note from the run', description: 'd' })],
    ALLOWED,
    messages,
    conversationId,
  );
  return messages;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-remember-gate-'));
  const data = new Map<string, unknown>();
  state = {
    get: <T>(key: string): T | undefined => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
  } as vscode.Memento;
  store = await MemoryStore.migrate(path.join(root, 'memories'), state);
  attachMemoryStore(state, store);

  registry = new ToolRegistry();
  registry.register(makeRememberTool(state));
  checkpoints = {
    snapshotBefore: vi.fn(),
    beginTurn: vi.fn(),
    commitTurn: vi.fn(),
  } as unknown as CheckpointStack;
  failureTracker = {
    recordNativeParseFailure: vi.fn(),
    reset: vi.fn(),
    shouldStrip: vi.fn().mockReturnValue(false),
  } as unknown as ToolFailureTracker;
  post = vi.fn();
  // The real pre-card answer, and nothing after it: a card would need a sidebar,
  // and reaching for one is exactly what these tests assert never happens.
  requestApproval = vi.fn(
    (
      toolName: string,
      detail: string,
      dangerous: boolean,
      conversationId: string | undefined,
      signal: AbortSignal | undefined,
      options: Parameters<typeof answerBeforeCard>[4],
    ) =>
      answerBeforeCard(toolName, detail, dangerous, conversationId, options, {
        unattended: unattendedConversations,
        clankerEnabled: false,
        autoApproved: () => undefined,
      }),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('remember in an unattended run', () => {
  it('refuses a bus turn naming approvals.unattended_bus.allow, and saves nothing', async () => {
    const dispatch = dispatchWith({ approvals: { unattended_bus: { allow: [] } } });
    const marker = unattendedConversations.mark('gate-bus-denied');
    try {
      const messages = await runRemember(dispatch, 'gate-bus-denied');
      expect(messages[0]?.content).toBe(expectedRefusal('approvals.unattended_bus.allow'));
      expect(store.read('lane-note')).toBeUndefined();
      expect(requestApproval).toHaveBeenCalledOnce();
      expect(requestApproval.mock.calls[0]?.[5]).toMatchObject({
        policyAllowPath: 'approvals.unattended_bus.allow',
        policyApprovalKey: 'tool:remember',
        softDenial: true,
      });
      // A refusal is not a protocol failure: the run is meant to carry on.
      expect(failureTracker.recordNativeParseFailure).not.toHaveBeenCalled();
    } finally {
      marker.dispose();
    }
  });

  it('refuses a job run naming approvals.jobs.<id>.allow, and saves nothing', async () => {
    const dispatch = dispatchWith({ approvals: { jobs: { 'weekly-scan': { allow: [] } } } });
    const marker = unattendedConversations.mark('gate-job-denied', {
      jobId: 'weekly-scan',
      jobName: 'Weekly session-log scan',
    });
    try {
      const messages = await runRemember(dispatch, 'gate-job-denied');
      expect(messages[0]?.content).toBe(
        expectedRefusal('approvals.jobs.weekly-scan.allow'),
      );
      expect(store.read('lane-note')).toBeUndefined();
    } finally {
      marker.dispose();
    }
  });

  it('saves when policy allows tool:remember, with no card', async () => {
    const dispatch = dispatchWith({
      approvals: { jobs: { 'weekly-scan': { allow: ['tool:remember'] } } },
    });
    const marker = unattendedConversations.mark('gate-job-allowed', {
      jobId: 'weekly-scan',
      jobName: 'Weekly session-log scan',
    });
    try {
      const messages = await runRemember(dispatch, 'gate-job-allowed');
      expect(store.read('lane-note')?.value).toBe('a note from the run');
      expect(messages[0]?.content).toContain('Remembered.');
      expect(requestApproval).not.toHaveBeenCalled();
    } finally {
      marker.dispose();
    }
  });

  it('saves in an attended chat with no card at all', async () => {
    const dispatch = dispatchWith({ approvals: { unattended_bus: { allow: [] } } });
    const messages = await runRemember(dispatch, 'gate-attended');
    expect(store.read('lane-note')?.value).toBe('a note from the run');
    expect(messages[0]?.content).toContain('Remembered.');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('saves in a Clanker chat with no card at all', async () => {
    const dispatch = dispatchWith({ approvals: { unattended_bus: { allow: [] } } }, () => true);
    const messages = await runRemember(dispatch, 'gate-clanker');
    expect(store.read('lane-note')?.value).toBe('a note from the run');
    expect(messages[0]?.content).toContain('Remembered.');
    expect(requestApproval).not.toHaveBeenCalled();
  });
});
