import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  commands: { executeCommand: vi.fn() },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    getConfiguration: () => ({ get: () => false }),
  },
  window: {
    createOutputChannel: () => ({
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
  },
}));

import type { ForgeConfig } from '../../src/config/types';
import { createChatRuleApproval } from '../../src/sidebar/chatApprovalRules';
import type { ChatRuleCall } from '../../src/sidebar/chatApprovalRules';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import { ToolApprovalService } from '../../src/sidebar/ToolApprovalService';
import { chatClankerRecords } from '../../src/sidebar/chatClanker';
import { approvalCallOptions } from '../../src/sidebar/approvalCallOptions';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import { makeShellTool } from '../../src/tools/shellTool';
import { TEST_BASH } from '../support/bash';
import { SLASH_COMMANDS } from '../../webview-ui/src/slashCommands';

const HOME = 'C:/Users/someone';
const WORKSPACE = 'N:/ws/project';
const FORGE_DIR = `${HOME}/.forge`;
const CLANKER_CHAT = 'clanker-chat';
const config: ForgeConfig = { models: [], active_model: null };
const conversation: ConversationRuntime = {
  id: CLANKER_CHAT,
  title: 'Test',
  createdAt: 1,
  updatedAt: 2,
  messages: [],
};
interface DropCase {
  source: string;
  call: Partial<ChatRuleCall>;
}

const DROP_CASES: DropCase[] = [
  { source: 'browserTools.ts:197 browser origin', call: { toolName: 'browser_search' } },
  { source: 'browserTools.ts:267 navigation origin', call: { toolName: 'browser_navigate' } },
  { source: 'browserTools.ts:347 new page origin', call: { toolName: 'browser_new_page' } },
  { source: 'browserActionTools.ts:149 click input', call: { toolName: 'browser_click', dangerous: true } },
  { source: 'browserActionTools.ts:189 type input', call: { toolName: 'browser_type', dangerous: true } },
  { source: 'browserActionTools.ts:229 press input', call: { toolName: 'browser_press', dangerous: true } },
  { source: 'desktopTools.ts:113 capture approval', call: { toolName: 'desktop_capture', dangerous: true } },
  { source: 'desktopTools.ts:227 focus approval', call: { toolName: 'desktop_focus_window', dangerous: true } },
  { source: 'desktopTools.ts:266 move approval', call: { toolName: 'desktop_move_mouse', dangerous: true } },
  { source: 'desktopTools.ts:319 click approval', call: { toolName: 'desktop_click', dangerous: true } },
  { source: 'desktopTools.ts:369 drag approval', call: { toolName: 'desktop_drag', dangerous: true } },
  { source: 'desktopTools.ts:410 scroll approval', call: { toolName: 'desktop_scroll', dangerous: true } },
  { source: 'desktopTools.ts:450 type approval', call: { toolName: 'desktop_type', dangerous: true } },
  { source: 'desktopTools.ts:486 press approval', call: { toolName: 'desktop_press', dangerous: true } },
  {
    source: 'fetchTool.ts:116 new host',
    call: {
      toolName: 'web_fetch',
      reachesOut: 'network',
      approvalMetadata: { approvalKey: 'net:example.org', reachesOut: 'network' },
    },
  },
  {
    source: 'fetchTool.ts:116 payload without secret taint',
    call: {
      toolName: 'web_fetch',
      dangerous: true,
      reachesOut: 'network',
      approvalMetadata: { gateKind: 'ownerGate', reachesOut: 'network' },
    },
  },
  {
    source: 'fileEditTools.ts:157 permanent delete restored by checkpoint',
    call: {
      toolName: 'delete_file',
      dangerous: true,
      approvalMetadata: {
        approvalKey: `rdelete:${WORKSPACE}`,
        approvalTargets: [`${WORKSPACE}/file.txt`],
      },
      mutationPaths: [`${WORKSPACE}/file.txt`],
    },
  },
  {
    source: 'exportDocumentTool.ts:source secret read into local export',
    call: {
      toolName: 'export_document',
      approvalMetadata: { approvalKey: 'tool:export_document' },
    },
  },
  {
    source: 'gitReadTool.ts:113 local secret read',
    call: {
      toolName: 'git_read',
      dangerous: true,
      approvalMetadata: {
        gateKind: 'ownerGate',
        approvalKey: `secret:${HOME}/.ssh/id_ed25519`,
      },
    },
  },
  { source: 'gitTools.ts:185 restore_file checkpointed overwrite', call: { toolName: 'restore_file' } },
  { source: 'imageSearchTool.ts:103 attached image upload', call: { toolName: 'image_search', dangerous: true } },
  { source: 'generateImageTool.ts:130 generation confirmation', call: { toolName: 'generate_image', dangerous: true } },
  { source: 'llamacppInstallTool.ts:106 install confirmation', call: { toolName: 'install_llamacpp' } },
  {
    source: 'localAgentTool.ts:198 local delegation gate',
    call: {
      toolName: 'ask_local_agent',
      args: { model: 'local-model' },
      dangerous: true,
      reachesOut: 'delegation',
      exitVerdict: { card: true, flaggedBy: 'content', gateKind: 'taintGate' },
    },
  },
  {
    source: 'jobTools.ts:166 CLI-agent consent gate',
    call: { toolName: 'manage_jobs', dangerous: true },
  },
  {
    source: 'messageChatTool.ts:113 steer confirmation',
    call: { toolName: 'message_chat', dangerous: true, reachesOut: 'cross_chat' },
  },
  { source: 'powerTools.ts:79 suspend confirmation', call: { toolName: 'sleep_computer', dangerous: true } },
  { source: 'powerTools.ts:160 wake timer confirmation', call: { toolName: 'schedule_wake' } },
  {
    source: 'readFileTool.ts:202 local secret read',
    call: {
      toolName: 'read_file',
      dangerous: true,
      approvalMetadata: {
        gateKind: 'ownerGate',
        approvalKey: `secret:${HOME}/.ssh/id_rsa`,
      },
    },
  },
  { source: 'semanticSearchTool.ts:33 index start gate', call: { toolName: 'search_codebase', dangerous: true } },
  {
    source: 'shellPolicy.ts:497 local secret read',
    call: {
      toolName: 'shell',
      dangerous: true,
      approvalMetadata: {
        gateKind: 'ownerGate',
        approvalKey: `secret:${HOME}/.ssh/id_rsa`,
      },
    },
  },
  {
    source: 'ToolApprovalService.ts:240 dangerous non-protected tool gate',
    call: { toolName: 'sleep_computer', dangerous: true },
  },
  {
    source: 'chatApprovalRules.ts:unkeyable non-protected call',
    call: { toolName: 'unknown_local_gate', dangerous: true, approvalMetadata: { gateKind: 'ownerGate' } },
  },
  {
    source: 'untrustedExitPolicy.ts:content egress to network',
    call: {
      toolName: 'web_fetch',
      toolGate: false,
      reachesOut: 'network',
      approvalMetadata: { approvalKey: 'net:example.org', reachesOut: 'network' },
      exitVerdict: { card: true, flaggedBy: 'content', gateKind: 'taintGate' },
    },
  },
  {
    source: 'untrustedExitPolicy.ts:content egress to another chat',
    call: {
      toolName: 'message_chat',
      toolGate: false,
      reachesOut: 'cross_chat',
      approvalMetadata: { approvalKey: 'cross_chat' },
      exitVerdict: { card: true, flaggedBy: 'content', gateKind: 'taintGate' },
    },
  },
  {
    source: 'untrustedExitPolicy.ts:content egress to delegation',
    call: {
      toolName: 'ask_local_agent',
      args: { model: 'local-model' },
      toolGate: false,
      reachesOut: 'delegation',
      exitVerdict: { card: true, flaggedBy: 'content', gateKind: 'taintGate' },
    },
  },
  {
    source: 'approvalKey.ts:unkeyable outside-workspace write',
    call: {
      toolName: 'write_file',
      outsideWorkspace: true,
      mutationPaths: ['N:/outside/file.txt'],
      outsideMutationPaths: ['N:/outside/file.txt'],
    },
  },
];

const CLANKER_RELEASED_REFUSALS: DropCase[] = [
  {
    source: 'exportDocumentTool.ts:secret output target',
    call: {
      toolName: 'export_document',
      dangerous: true,
      approvalMetadata: { dangerous: true, detail: 'Write export output to a secret path.' },
    },
  },
  {
    source: 'shellToolCallGate.ts:23 non-owner parse refusal',
    call: {
      toolName: 'shell',
      approvalMetadata: {
        detail: 'Clanker will run this non-owner, non-deny-list shell call.',
      },
    },
  },
];

function makeCall(overrides: Partial<ChatRuleCall> = {}): ChatRuleCall {
  return {
    toolName: 'test_tool',
    args: {},
    dangerous: false,
    toolGate: true,
    outsideWorkspace: false,
    declaredSafe: false,
    reachesOut: 'none',
    approvalMetadata: {},
    exitVerdict: { card: true },
    mutationPaths: [],
    outsideMutationPaths: [],
    conversationId: CLANKER_CHAT,
    conversation,
    ...overrides,
  };
}

function makeRules(enabled: boolean, recorded: string[]) {
  return createChatRuleApproval({
    getConfig: () => config,
    workspaceRoot: WORKSPACE,
    home: HOME,
    platform: 'win32',
    clankerMode: () => enabled,
    recordAutoGate: (event) => recorded.push(event.answeredBy),
  });
}

describe('Clanker answers every non-protected approval', () => {
  it('shows the exact three-stop description', () => {
    expect(SLASH_COMMANDS.find((command) => command.trigger === 'clanker')?.description).toBe(
      "Toggle full-auto mode — no confirmation prompts until you run /clanker again. Destructive commands, Forge's own guard files, and sending data out after reading a secret still stop.",
    );
  });

  it.each(DROP_CASES)('$source', ({ call: overrides }) => {
    const recorded: string[] = [];
    const decision = makeRules(true, recorded).decide(makeCall(overrides));
    expect(decision?.kind).toBe('answered');
    expect(recorded.at(-1)).toBe('clanker');
  });

  it.each(CLANKER_RELEASED_REFUSALS)('answers $source with Clanker', ({ call: overrides }) => {
    const recorded: string[] = [];
    const decision = makeRules(true, recorded).decide(makeCall(overrides));
    expect(decision?.kind).toBe('answered');
    expect(recorded.at(-1)).toBe('clanker');
  });

  it.each(DROP_CASES)('keeps $source on the approval path with Clanker off', async ({ call: overrides }) => {
    const recorded: string[] = [];
    const approvalCall = makeCall(overrides);
    const decision = makeRules(false, recorded).decide(approvalCall);
    expect(decision?.kind).not.toBe('answered');
    expect(recorded).toEqual([]);

    const posted: { type: string; id?: string }[] = [];
    const service = new ToolApprovalService(
      (message) => posted.push(message as { type: string; id?: string }),
      () => ({}) as never,
    );
    const options = approvalCallOptions(
      approvalCall.approvalMetadata,
      approvalCall.exitVerdict,
      undefined,
      approvalCall.reachesOut,
    );
    const pending = service.request(
      approvalCall.toolName,
      'test gate',
      approvalCall.dangerous,
      CLANKER_CHAT,
      undefined,
      options,
    );
    const card = posted.find((message) => message.type === 'confirmRequest');
    expect(card?.type).toBe('confirmRequest');
    if (!card?.id) throw new Error('approval card was not posted');
    service.resolve(card.id, 'decline');
    await expect(pending).resolves.toBe('declined');
  });
});

describe('Clanker keeps destructive, owner-only and secret-egress stops', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not answer a deny-list call', () => {
    const recorded: string[] = [];
    const decision = makeRules(true, recorded).decide(
      makeCall({
        toolName: 'shell',
        dangerous: true,
        approvalMetadata: { dangerous: true, gateKind: 'denyList' },
      }),
    );
    expect(decision).toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it('does not answer a destructive tool gate outside the turn checkpoint', async () => {
    const recorded: string[] = [];
    const call = makeCall({
      toolName: 'forget',
      approvalMetadata: { clankerStop: true, detail: 'Remove stored memory?' },
    });
    const decision = makeRules(true, recorded).decide(call);
    expect(decision?.kind).toBe('offer');
    expect(recorded).toEqual([]);

    const posted: { type: string; id?: string }[] = [];
    const service = new ToolApprovalService(
      (message) => posted.push(message as { type: string; id?: string }),
      () => ({}) as never,
    );
    service.setClankerMode(CLANKER_CHAT, true);
    const pending = service.request('forget', 'Remove stored memory?', false, CLANKER_CHAT, undefined, {
      clankerStop: true,
    });
    const card = posted.find((message) => message.type === 'confirmRequest');
    expect(card?.type).toBe('confirmRequest');
    if (!card?.id) throw new Error('destructive approval card was not posted');
    service.resolve(card.id, 'decline');
    await expect(pending).resolves.toBe('declined');
  });

  it('expires a default-armed chat at the approval decision and posts the exact notice once', async () => {
    const conv: ConversationRuntime = {
      id: CLANKER_CHAT,
      title: 'Default chat',
      createdAt: 1,
      updatedAt: 1,
      clanker: true,
      clankerSource: 'policy-default',
      messages: [],
    };
    const posted: { type: string; message?: string; id?: string }[] = [];
    const records = chatClankerRecords((id) => (id === conv.id ? conv : undefined));
    const service = new ToolApprovalService(
      (message) => posted.push(message as { type: string; message?: string; id?: string }),
      () => ({}) as never,
      undefined,
      undefined,
      records,
      undefined,
      undefined,
      () => undefined,
      (conversationId, notice) => posted.push({ type: 'notice', message: notice, id: conversationId }),
    );
    const pending = service.request('forget', 'Remove stored memory?', false, conv.id, undefined, {
      clankerStop: true,
    });
    const expectedNotice =
      "Clanker's default from policy.yaml has ended, so this chat is gated again. Turn it back on with /clanker.";
    expect(posted.find((message) => message.type === 'notice')?.message).toBe(expectedNotice);
    expect(conv.clanker).toBe(false);
    expect(conv.clankerSource).toBeUndefined();
    const card = posted.find((message) => message.type === 'confirmRequest');
    expect(card?.type).toBe('confirmRequest');
    if (!card?.id) throw new Error('protected stop approval card was not posted');
    service.resolve(card.id, 'decline');
    await expect(pending).resolves.toBe('declined');
    expect(posted.filter((message) => message.type === 'notice')).toHaveLength(1);
  });

  it('keeps the owner-only wall ahead of the key, policy and Clanker checks', () => {
    const recorded: string[] = [];
    const rules = createChatRuleApproval({
      getConfig: () => ({
        ...config,
        approvals: { always: [{ key: `write:${FORGE_DIR}`, workspace: WORKSPACE }] },
      }),
      workspaceRoot: WORKSPACE,
      home: HOME,
      platform: 'win32',
      clankerMode: () => true,
      recordAutoGate: (event) => recorded.push(event.answeredBy),
    });
    const decision = rules.decide(
      makeCall({
        toolName: 'write_file',
        dangerous: false,
        outsideWorkspace: false,
        mutationPaths: [`${FORGE_DIR}/policy.yaml`],
        outsideMutationPaths: [],
        approvalMetadata: { approvalKey: `write:${FORGE_DIR}` },
      }),
    );
    expect(decision).toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it('does not answer network egress after a secret read', () => {
    const recorded: string[] = [];
    const decision = makeRules(true, recorded).decide(
      makeCall({
        toolName: 'web_fetch',
        toolGate: true,
        reachesOut: 'network',
        approvalMetadata: {
          approvalKey: 'secret-net:collector.example',
          gateKind: 'taintGate',
          secretReadTaint: true,
        },
        exitVerdict: { card: true, flaggedBy: 'secret', gateKind: 'taintGate' },
      }),
    );
    expect(decision?.kind).toBe('offer');
    expect(recorded).toEqual([]);
  });

  it('does not answer cross-chat egress after a secret read without secretReadTaint metadata', () => {
    const recorded: string[] = [];
    const decision = makeRules(true, recorded).decide(
      makeCall({
        toolName: 'message_chat',
        toolGate: false,
        reachesOut: 'cross_chat',
        approvalMetadata: { approvalKey: 'cross_chat' },
        exitVerdict: { card: true, flaggedBy: 'secret', gateKind: 'taintGate' },
      }),
    );
    expect(decision?.kind).toBe('offer');
    expect(recorded).toEqual([]);
    expect(
      approvalCallOptions(undefined, {
        card: true,
        flaggedBy: 'secret',
        gateKind: 'taintGate',
      }, undefined, 'cross_chat').clankerStop,
    ).toBe(true);
    expect(
      approvalCallOptions(undefined, {
        card: true,
        flaggedBy: 'content',
        gateKind: 'taintGate',
      }, undefined, 'cross_chat').clankerStop,
    ).toBeUndefined();
  });
});

describe('Clanker releases non-protected shell refusals', () => {
  it.skipIf(!TEST_BASH)('executes a parse refusal with an attended Clanker chat', async () => {
    const tool = makeShellTool({ bashPath: TEST_BASH, clankerMode: () => true });
    const args = { command: "cat <<'EOF" };
    const metadata = await tool.approval?.(args, { conversationId: CLANKER_CHAT });
    expect(metadata?.detail).toContain('Clanker will run this non-owner, non-deny-list shell call.');
    const context = {
      beforeMutate: () => undefined,
      conversationId: CLANKER_CHAT,
      clankerMode: true,
    };
    const result = await tool.handler(args, context);
    expect(typeof result).toBe('string');
    if (typeof result === 'string') expect(result).not.toContain('(deny list)');
  });

  it.skipIf(!TEST_BASH)('keeps a non-owner parse refusal when Clanker is off', async () => {
    const tool = makeShellTool({ bashPath: TEST_BASH, clankerMode: () => false });
    await expect(
      tool.handler(
        { command: "cat <<'EOF" },
        { beforeMutate: () => undefined, conversationId: CLANKER_CHAT, clankerMode: false },
      ),
    ).rejects.toThrow('shell:');
  });

  it('keeps a deny-list shell refusal tagged as a protected gate', async () => {
    const tool = makeShellTool({ bashPath: TEST_BASH, clankerMode: () => true });
    const metadata = await tool.approval?.(
      { command: 'diskpart clean' },
      { conversationId: CLANKER_CHAT },
    );
    expect(metadata).toBeUndefined();
  });
});

describe('Clanker mode does not answer unattended tool gates', () => {
  it('keeps the existing policy-denied outcome', async () => {
    const marker = unattendedConversations.mark(CLANKER_CHAT, { jobId: 'job-1', jobName: 'test' });
    try {
      const posted: { type: string }[] = [];
      const service = new ToolApprovalService(
        (message) => posted.push(message as { type: string }),
        () => ({}) as never,
      );
      service.setClankerMode(CLANKER_CHAT, true);
      await expect(
        service.request('sleep_computer', 'suspend', true, CLANKER_CHAT),
      ).rejects.toMatchObject({
        name: 'ToolApprovalPolicyDenied',
        message: expect.stringContaining('unattended: dangerous tool denied by policy'),
      });
    expect(posted.some((message) => message.type === 'confirmRequest')).toBe(false);
    } finally {
      marker.dispose();
    }
  });
});
