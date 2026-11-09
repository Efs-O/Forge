/**
 * What the dispatch does when a chat rule or attended Clanker covers a gated call:
 * it runs with no card and writes a `gate` row naming the answer. Clanker answers
 * keyed and unkeyable calls except deny-list matches, Forge's owner-only wall,
 * explicit destructive markers, and secret egress.
 *
 * Clanker-off and unattended rows must keep their existing behavior —
 * `test/unit/ToolDispatch.test.ts` pins the normal path, and this file exercises the
 * changed path through the real shell and the same `GateEventLog` used by sessions.
 *
 * Clanker is scoped to one chat. The deny list and K2/K3 stops still reach the
 * owner; ordinary tool gates, danger labels and unkeyable calls get Clanker's
 * answer. A keyed recursive delete may still be answered by an owner-created rule.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { makeShellTool } from '../../src/tools/shellTool';
import { makeMessageChatTool } from '../../src/tools/messageChatTool';
import { makeWebFetchTool } from '../../src/tools/fetchTool';
import { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import { createChatRuleApproval, resetChatApprovals } from '../../src/sidebar/chatApprovalRules';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import { GateEventLog, type GateEventRow } from '../../src/sidebar/gateEventLog';
import type { CheckpointStack } from '../../src/sidebar/CheckpointStack';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import type { ToolFailureTracker } from '../../src/tools/StripTools';
import type { ForgeConfig } from '../../src/config/types';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { ToolApprovalCallOptions } from '../../src/sidebar/toolApprovalOutcome';
import { persistedToRuntime, runtimeToPersisted } from '../../src/sidebar/sessionPersistence';
import { clearConversationHostApprovals } from '../../src/tools/fetchHostApprovals';
import { clearConversationSecretState, markConversationReadSecret } from '../../src/tools/exfilTaint';

/** A real folder the shell can `cd` into, so the delete rows below run for real.
 * The key the shell works out is case-folded on win32, so the rule the chat holds
 * is compared against it case-insensitively — exactly the shape an owner's click
 * would store.
 */
const WORKDIR = path.join(os.tmpdir(), 'forge-chat-rule-rdelete');
const RULE_KEY = `rdelete:${WORKDIR.replace(/\\/gu, '/')}/deep`;
const KEY_ROW = `rdelete:${WORKDIR.replace(/\\/gu, '/').toLowerCase()}/deep`;
const FORGE_HOME = 'C:/Users/someone';

function conversation(rules: string[], options: { flagged?: boolean } = {}): ConversationRuntime {
  return {
    id: 'chat-1',
    title: 'Rules',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    approval_rules: [...rules],
    ...(options.flagged ? { untrusted_since_ms: Date.now() } : {}),
  };
}

interface HarnessOptions {
  approve?: 'approved' | 'declined';
  /** Arm Clanker for 'chat-1', the way the queue arms the chat its owner toggled. */
  clanker?: boolean;
  /** The chat took in a page, so its exits are the ones that need an answer. */
  flagged?: boolean;
  /** Simulate the owner choosing Allow for this chat on the first eligible card. */
  allowForChat?: boolean;
}

function harness(rules: string[], options: HarnessOptions = {}) {
  const approve = options.approve ?? 'approved';
  const registry = new ToolRegistry();
  const config: ForgeConfig = { permissions: { exec: { shell: 'bash' } } };
  registry.register(
    makeShellTool({ home: FORGE_HOME, platform: 'win32', getConfig: () => config }),
  );
  // The real `message_chat`, with the sidebar seam it reads through faked: its own
  // declarations (`autoApprove` plus `reachesOut: 'cross_chat'`) are what give the
  // call its key, so testing the real tool is what proves the key is real.
  const deliverChatMessage = vi.fn(async (_text: string, _id: string, _steer?: boolean) => ({
    kind: 'turn' as const,
  }));
  registry.register(
    makeMessageChatTool({
      getConfig: () => config,
      getSidebar: () => ({
        getHostFacade: () => ({
          status: () => ({
            activeConversationId: 'chat-1',
            conversations: [
              { id: 'chat-1', title: 'Rules', archived: false, messageCount: 0 },
              { id: 'target', title: 'Other chat', archived: false, messageCount: 0 },
            ],
            requestChains: [],
            streamingConversationIds: [],
          }),
          emitHostActivity: vi.fn(),
          chatCapBlockers: vi.fn(() => []),
          createConversation: vi.fn(),
          setConversationModel: vi.fn(),
          applyAutoTitle: vi.fn(),
          recentExchanges: vi.fn(() => []),
          clankerMode: (conversationId: string) => options.clanker === true && conversationId === 'chat-1',
        }),
        deliverChatMessage,
      }),
    }),
  );
  registry.register(
    makeWebFetchTool({
      getConfig: () => config,
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetch: (async () =>
        new Response('<p>fixture page</p>', {
          headers: { 'content-type': 'text/html' },
        })) as never,
    }),
  );
  const rows: GateEventRow[] = [];
  const gateLog = new GateEventLog({ write: (row) => rows.push(row), now: () => Date.now() });
  const records = new Map<string, ConversationRuntime>();
  const persist = vi.fn();
  const chatRuleApproval = createChatRuleApproval({
    getConfig: () => config,
    workspaceRoot: WORKDIR,
    home: FORGE_HOME,
    platform: 'win32',
    ...(options.clanker
      ? { clankerMode: (conversationId: string) => conversationId === 'chat-1' }
      : {}),
    recordAutoGate: (event) => gateLog.autoApproved(event),
    lookup: (conversationId) => records.get(conversationId),
    persist,
  });
  const requestApproval = vi.fn(
    async (
      _toolName: string,
      _detail: string,
      _dangerous: boolean,
      conversationId: string | undefined,
      _signal: AbortSignal | undefined,
      callOptions?: ToolApprovalCallOptions,
    ) => {
      if (options.allowForChat && conversationId && callOptions?.allowForChat) {
        const failures = chatRuleApproval.allow(conversationId, callOptions.allowForChat.keys);
        if (failures.length) throw new Error(failures.map((failure) => failure.reason).join('; '));
      }
      return approve;
    },
  );
  const dispatch = new ToolDispatch(
    registry,
    { snapshotBefore: vi.fn(), readSnapshotContent: vi.fn() } as unknown as CheckpointStack,
    { markPending: vi.fn() } as unknown as KeepUndoCodeLensProvider,
    {
      record: vi.fn(),
      reset: vi.fn(),
      shouldStrip: vi.fn().mockReturnValue(false),
    } as unknown as ToolFailureTracker,
    vi.fn(),
    requestApproval,
    { apply: vi.fn() } as unknown as DiffDecorations,
    chatRuleApproval,
  );
  const runCalls = async (
    name: string,
    args: Record<string, unknown>,
    conversationId = 'chat-1',
  ) => {
    const stored =
      records.get(conversationId) ??
      conversation(rules, { flagged: options.flagged });
    stored.id = conversationId;
    records.set(conversationId, stored);
    const messages: never[] = [];
    await dispatch.dispatch(
      [
        {
          id: `call-${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
      new Set(['headless', 'terminal', 'delegate', 'fetch']),
      messages,
      conversationId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        modelName: 'test-model',
        isVisionModel: false,
        conversation: {
          ...stored,
        },
      },
    );
    return String((messages[0] as { content: string }).content);
  };
  return {
    rows,
    requestApproval,
    deliverChatMessage,
    records,
    persist,
    chatRuleApproval,
    reload: (conversationId = 'chat-1') => {
      const current = records.get(conversationId);
      if (!current) throw new Error('the test chat has no stored record');
      const saved = runtimeToPersisted(
        { activeConversationId: conversationId, conversations: [current], history: [] },
        { withHistory: false },
      );
      records.set(conversationId, persistedToRuntime(saved.conversations[0]!));
    },
    run: (command: string) => runCalls('shell', { command, cwd: WORKDIR }),
    runAs: (conversationId: string, command: string) =>
      runCalls('shell', { command, cwd: WORKDIR }, conversationId),
    runMessageChat: () => runCalls('message_chat', { to: 'target', message: 'a build note' }),
    runMessageChatAs: (conversationId: string) =>
      runCalls('message_chat', { to: 'target', message: 'a build note' }, conversationId),
    runFetch: (url: string) => runCalls('web_fetch', { url }),
  };
}

beforeAll(() => {
  fs.mkdirSync(WORKDIR, { recursive: true });
  const folders = vscode.workspace.workspaceFolders as
    | Array<{ uri: { fsPath: string } }>
    | undefined;
  if (folders) {
    folders.length = 0;
    folders.push({ uri: { fsPath: WORKDIR } });
  }
});

afterAll(() => {
  fs.rmSync(WORKDIR, { recursive: true, force: true });
});

describe('a covered call runs with no card and leaves one gate row', () => {
  it('offers, stores, and reloads the cross-chat rule from the same card', async () => {
    const probe = harness([], { flagged: true, allowForChat: true });
    await probe.runMessageChat();

    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(probe.requestApproval.mock.calls[0]?.[5]).toMatchObject({
      allowForChat: { keys: ['cross_chat'], label: 'messages to other chats' },
    });
    expect(probe.persist).toHaveBeenCalledWith('chat-1');
    expect(probe.records.get('chat-1')?.approval_rules).toEqual(['cross_chat']);

    probe.reload();
    await probe.runMessageChat();
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(probe.rows.at(-1)).toMatchObject({
      kind: 'auto',
      answered_by: 'chat_rule',
      approval_key: 'cross_chat',
    });

    resetChatApprovals(probe.records.get('chat-1')!);
    await probe.runMessageChat();
    expect(probe.requestApproval).toHaveBeenCalledTimes(2);
    expect(probe.requestApproval.mock.calls[1]?.[5]).toMatchObject({
      allowForChat: { keys: ['cross_chat'] },
    });
  });

  it('a new-host fetch approval reseeds from the conversation after a simulated reload', async () => {
    clearConversationHostApprovals('chat-1');
    const probe = harness([], { flagged: true, allowForChat: true });
    await probe.runFetch('https://docs.example.test/page');

    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(probe.requestApproval.mock.calls[0]?.[5]).toMatchObject({
      allowForChat: { keys: ['net:docs.example.test'], label: 'any request to docs.example.test' },
    });
    expect(probe.records.get('chat-1')?.approval_rules).toEqual(['net:docs.example.test']);

    clearConversationHostApprovals('chat-1');
    probe.reload();
    await probe.runFetch('https://docs.example.test/another-page');
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    clearConversationHostApprovals('chat-1');
  });

  it('allows one host per secret-tainted chat and keeps Clanker out of the decision', async () => {
    clearConversationHostApprovals('chat-1');
    const probe = harness(['net:a.example'], { allowForChat: true });
    markConversationReadSecret('chat-1', '**/.env', 'read_file .env');

    await probe.runFetch('https://a.example/first');
    expect(probe.requestApproval.mock.calls[0]?.[5]).toMatchObject({
      allowForChat: {
        keys: ['secret-net:a.example'],
        label: 'any request to a.example after a secret read',
      },
    });
    expect(probe.requestApproval.mock.calls[0]?.[5]?.cardReason).toContain('read_file .env');
    expect(probe.records.get('chat-1')?.approval_rules).toEqual([
      'net:a.example',
      'secret-net:a.example',
    ]);
    await probe.runFetch('https://a.example/second');
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    await probe.runFetch('https://b.example/');
    expect(probe.requestApproval).toHaveBeenCalledTimes(2);
    clearConversationHostApprovals('chat-1');
    clearConversationSecretState('chat-1');

    const clanker = harness([], { clanker: true });
    markConversationReadSecret('chat-1', '**/.env', 'read_file .env');
    await clanker.runFetch('https://a.example/');
    expect(clanker.requestApproval).toHaveBeenCalledTimes(1);
    expect(clanker.rows).toHaveLength(0);
    clearConversationHostApprovals('chat-1');
    clearConversationSecretState('chat-1');
  });

  it('keeps encoded payloads unkeyable even with an after-secret host rule', async () => {
    const probe = harness(['secret-net:a.example']);
    markConversationReadSecret('chat-1', '**/.env', 'read_file .env');

    await probe.runFetch(`https://a.example/?d=${'QUJD'.repeat(30)}`);

    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(probe.requestApproval.mock.calls[0]?.[5]).not.toHaveProperty('allowForChat');
    expect(probe.requestApproval.mock.calls[0]?.[5]?.gateKind).toBe('taintGate');
    clearConversationHostApprovals('chat-1');
    clearConversationSecretState('chat-1');
  });

  it('does not offer a rule for a protected folder key', () => {
    const probe = harness([]);
    const decision = probe.chatRuleApproval.decide({
      toolName: 'shell',
      args: {},
      dangerous: true,
      toolGate: true,
      outsideWorkspace: false,
      declaredSafe: false,
      reachesOut: 'none',
      approvalMetadata: { approvalKey: 'rdelete:C:/Windows' } as never,
      exitVerdict: {} as never,
      mutationPaths: [],
      outsideMutationPaths: [],
      conversationId: 'chat-1',
      conversation: conversation([]),
    });
    expect(decision).toBeUndefined();
  });

  it('allowing a recursive-delete folder covers its children but not a neighbour', async () => {
    const probe = harness([], { allowForChat: true });
    await probe.run('rm -rf ./deep/build');
    expect(probe.requestApproval.mock.calls[0]?.[5]).toMatchObject({
      allowForChat: {
        keys: [`rdelete:${WORKDIR.replace(/\\/gu, '/')}/deep`.toLowerCase()],
        label: `recursive deletes inside ${WORKDIR.replace(/\\/gu, '/')}/deep`.toLowerCase(),
      },
    });
    await probe.run('rm -rf ./deep/cache');
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    await probe.run('rm -rf ./other/build');
    expect(probe.requestApproval).toHaveBeenCalledTimes(2);
  });

  it('runs `rm -rf ./deep/build` allowed by a rule for that folder', async () => {
    const probe = harness([RULE_KEY]);
    const result = await probe.run('rm -rf ./deep/build');
    expect(probe.requestApproval).not.toHaveBeenCalled();
    expect(result).toMatch(/exit 0/u);
    expect(probe.rows).toHaveLength(1);
    const row = probe.rows[0]!;
    expect(row.kind).toBe('auto');
    expect(row.answered_by).toBe('chat_rule');
    expect(row.approval_key).toBe(KEY_ROW);
    expect(row.tool).toBe('shell');
    expect(row.conversation_id).toBe('chat-1');
    expect(row.timestamp_ms).toBeGreaterThan(0);
  });

  it('writes no row when the rule does not cover the folder the delete is inside', async () => {
    const probe = harness([`rdelete:${WORKDIR.replace(/\\/gu, '/')}/other`]);
    await probe.run('rm -rf ./deep/build');
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(probe.rows).toHaveLength(0);
  });

  it('opens the card as today for a chat with no rules', async () => {
    const probe = harness([]);
    await probe.run('rm -rf ./deep/build');
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(probe.requestApproval.mock.calls[0]?.[2]).toBe(true); // dangerous
    expect(probe.rows).toHaveLength(0);
  });

  it('opens the card for a dangerous command that has no key at all', async () => {
    const probe = harness([RULE_KEY, 'tool:shell'], { approve: 'declined' });
    const result = await probe.run('git reset --hard');
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/declined|not run/iu);
    expect(probe.rows).toHaveLength(0);
    expect(probe.requestApproval.mock.calls[0]?.[5]).not.toHaveProperty('allowForChat');
  });

  it('ignores chat rules in an unattended run, even when every key is allowed', async () => {
    const marker = unattendedConversations.mark('chat-1', { jobId: 'job-1', jobName: 'test' });
    const probe = harness([RULE_KEY]);
    await probe.run('rm -rf ./deep/build');
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(probe.rows).toHaveLength(0);
    expect(probe.requestApproval.mock.calls[0]?.[5]).not.toHaveProperty('allowForChat');
    marker.dispose();
  });
});

describe('Clanker, armed for this chat, answers a key the owner could have allowed', () => {
  it('asks the owner for a keyed deny-list delete: the deny list still asks', async () => {
    // No chat rule covers the folder, so Clanker is the only thing that could have
    // answered it, and plan §2 keeps the deny list out of its reach: the banner
    // promises "the deny list still asks". The card opens, the owner's answer runs
    // the delete, and no `auto` row claims Clanker answered a call it must leave.
    const probe = harness([], { clanker: true });
    const result = await probe.run('rm -rf ./deep/build');
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(probe.requestApproval.mock.calls[0]?.[2]).toBe(true); // dangerous
    expect(result).toMatch(/exit 0/u); // the card answered it, so the delete ran
    expect(probe.rows).toHaveLength(0);
  });

  it('still lets a chat rule answer that same delete, row saying `chat_rule`', async () => {
    // Only Clanker is excluded. The rule the owner clicked for this chat answers the
    // deny-list delete exactly as it did in phase 2, and the row names that rule.
    const probe = harness([RULE_KEY], { clanker: true });
    const result = await probe.run('rm -rf ./deep/build');
    expect(probe.requestApproval).not.toHaveBeenCalled();
    expect(result).toMatch(/exit 0/u);
    expect(probe.rows).toHaveLength(1);
    const row = probe.rows[0]!;
    expect(row.kind).toBe('auto');
    expect(row.answered_by).toBe('chat_rule');
    expect(row.approval_key).toBe(KEY_ROW);
    expect(row.dangerous).toBe(true);
  });

  it('answers a flagged chat sending `message_chat` with no card, key `cross_chat`', async () => {
    // The plan's acceptance case: a chat that took in a page, with Clanker on, sends
    // `message_chat` with no card, and the ledger says who answered and with what key.
    const probe = harness([], { clanker: true, flagged: true });
    await probe.runMessageChat();
    expect(probe.requestApproval).not.toHaveBeenCalled();
    // The envelope names the sender, so assert the message rode inside it rather
    // than asserting one exact string the tool may reformat next release.
    expect(String(probe.deliverChatMessage.mock.calls[0]?.[0])).toContain('a build note');
    expect(probe.deliverChatMessage.mock.calls[0]?.[1]).toBe('target');
    expect(probe.rows).toHaveLength(1);
    const row = probe.rows[0]!;
    expect(row.kind).toBe('auto');
    expect(row.answered_by).toBe('clanker');
    expect(row.approval_key).toBe('cross_chat');
    expect(row.tool).toBe('message_chat');
    expect(row.conversation_id).toBe('chat-1');
  });

  it('leaves an unattended run alone even with a chat armed and every key allowed', async () => {
    const marker = unattendedConversations.mark('chat-1', { jobId: 'job-1', jobName: 'test' });
    const probe = harness([], { clanker: true });
    await probe.run('rm -rf ./deep/build');
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(probe.rows).toHaveLength(0);
    marker.dispose();
  });

  it('keeps an unkeyable deny-list command on its card', async () => {
    const probe = harness([], { approve: 'declined', clanker: true });
    const result = await probe.run('git reset --hard');
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/declined|not run/iu);
    // A card answers it, so the row is the card's own, written by the sink — not an
    // `auto` row claiming Clanker answered a call it had no key for.
    expect(probe.rows).toHaveLength(0);
  });

  it('does not offer a chat rule for the deny-list command `git rebase`', async () => {
    const probe = harness([], { approve: 'declined' });
    await probe.run('git rebase main');
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(probe.requestApproval.mock.calls[0]?.[5]).not.toHaveProperty('allowForChat');
  });

  it('leaves the next chat in the same window gated while this one runs free', async () => {
    // Clanker is armed for 'chat-1' and for no other, so the seam has to follow the
    // chat. `message_chat` is the call Clanker answers here: `cross_chat` is a key the
    // owner could have allowed and the deny list is not involved, so the armed chat
    // sends with no card while the same send from another conversation id gets its
    // card, and no `clanker` row is written for a chat that never armed the mode.
    const probe = harness([], { approve: 'declined', clanker: true, flagged: true });
    await probe.runMessageChat();
    expect(probe.requestApproval).not.toHaveBeenCalled();
    expect(probe.rows).toHaveLength(1);
    const neighbour = await probe.runMessageChatAs('chat-2');
    expect(probe.requestApproval).toHaveBeenCalledTimes(1);
    expect(probe.requestApproval.mock.calls[0]?.[3]).toBe('chat-2');
    expect(neighbour).toMatch(/declined|not run/iu);
    expect(probe.rows).toHaveLength(1);
    expect(probe.rows[0]!.conversation_id).toBe('chat-1');
  });
});
