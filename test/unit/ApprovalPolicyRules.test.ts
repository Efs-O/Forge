import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/ConfigLoader';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig } from '../../src/config/types';
import {
  approvalPolicyDecision,
  approvalPolicyLinesForWorkspace,
  writeApprovalAlways,
} from '../../src/sidebar/approvalPolicyRules';
import { approvalEnvFor, createChatRuleApproval } from '../../src/sidebar/chatApprovalRules';
import { handleApprovalsSlashCommand } from '../../src/sidebar/approvalSlashCommands';
import { ToolApprovalPolicyDenied } from '../../src/sidebar/toolApprovalOutcome';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import type { ChatRuleCall } from '../../src/sidebar/chatApprovalRules';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

const HOME = 'C:/Users/someone';
const WORKSPACE = 'N:/ws/project';
const OTHER_WORKSPACE = 'N:/ws/other';
const configFor = (approvals?: ForgeConfig['approvals']): ForgeConfig => ({
  models: [],
  active_model: null,
  ...(approvals ? { approvals } : {}),
});
const context = approvalEnvFor({
  getConfig: () => configFor(),
  home: HOME,
  platform: 'win32',
  workspaceRoot: WORKSPACE,
}).ctx;
const requirement = { key: 'cross_chat' };

function call(conversation: ConversationRuntime): ChatRuleCall {
  return {
    toolName: 'message_chat',
    args: {},
    dangerous: false,
    toolGate: true,
    outsideWorkspace: false,
    declaredSafe: false,
    reachesOut: 'cross_chat',
    approvalMetadata: { approvalKey: 'cross_chat' },
    exitVerdict: { card: true },
    mutationPaths: [],
    outsideMutationPaths: [],
    conversationId: conversation.id,
    conversation,
  };
}

describe('approval policy decisions', () => {
  it('does not let an ordinary network policy rule answer a secret-tainted fetch', () => {
    expect(
      approvalPolicyDecision(
        { always: [{ key: 'net:a.example', workspace: WORKSPACE }] },
        [{ key: 'secret-net:a.example' }],
        context,
        WORKSPACE,
        false,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('answers before chat rules and Clanker for an owner project rule', () => {
    const conversation: ConversationRuntime = {
      id: 'chat-1',
      title: 'Test',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      approval_rules: ['cross_chat'],
    };
    const recorded: string[] = [];
    const approval = createChatRuleApproval({
      getConfig: () => configFor({
        always: [{ key: 'cross_chat', workspace: WORKSPACE }],
      }),
      workspaceRoot: WORKSPACE,
      home: HOME,
      platform: 'win32',
      clankerMode: () => true,
      recordAutoGate: (event) => recorded.push(event.answeredBy),
      lookup: () => conversation,
    });

    expect(approval.decide(call(conversation))).toEqual({ kind: 'answered', key: 'cross_chat' });
    expect(recorded).toEqual(['policy_rule']);
  });

  it('uses a newly written project rule immediately in the same window', () => {
    const config = configFor();
    const conversation: ConversationRuntime = {
      id: 'chat-new-rule',
      title: 'Test',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    const approval = createChatRuleApproval({
      getConfig: () => config,
      workspaceRoot: WORKSPACE,
      configPath: 'config.yaml',
      home: HOME,
      platform: 'win32',
      recordAutoGate: vi.fn(),
      writeAlways: () => ({ kind: 'written' }),
    });
    expect(approval.always(['cross_chat'])).toEqual({ kind: 'written' });
    expect(approval.decide(call(conversation))).toEqual({ kind: 'answered', key: 'cross_chat' });
    expect(config.approvals?.always).toEqual([{ key: 'cross_chat', workspace: WORKSPACE }]);

    const newChat = createChatRuleApproval({
      getConfig: () => config,
      workspaceRoot: WORKSPACE,
      home: HOME,
      platform: 'win32',
      recordAutoGate: vi.fn(),
    });
    expect(newChat.decide(call({ ...conversation, id: 'new-chat' }))).toEqual({
      kind: 'answered',
      key: 'cross_chat',
    });
  });

  it('limits project rules to their workspace and allows an unscoped owner rule everywhere', () => {
    const approvals: ForgeConfig['approvals'] = {
      always: [
        { key: 'cross_chat', workspace: WORKSPACE },
        { key: 'tool:browser' },
      ],
    };
    expect(approvalPolicyDecision(approvals, [requirement], context, WORKSPACE, false)).toEqual({
      kind: 'allowed',
      key: 'cross_chat',
    });
    expect(approvalPolicyDecision(approvals, [requirement], context, OTHER_WORKSPACE, false)).toEqual({
      kind: 'none',
    });
    expect(
      approvalPolicyDecision(approvals, [{ key: 'tool:browser' }], context, OTHER_WORKSPACE, false),
    ).toEqual({ kind: 'allowed', key: 'tool:browser' });
  });

  it('uses separate unattended job and agent-bus allow lists with the exact refusal path', () => {
    const approvals: ForgeConfig['approvals'] = {
      jobs: { 'strata-update': { allow: ['cross_chat'] } },
      unattended_bus: { allow: ['tool:browser'] },
    };
    expect(approvalPolicyDecision(approvals, [requirement], context, WORKSPACE, true, 'strata-update'))
      .toEqual({ kind: 'allowed', key: 'cross_chat' });
    expect(approvalPolicyDecision(approvals, [{ key: 'tool:browser' }], context, WORKSPACE, true))
      .toEqual({ kind: 'allowed', key: 'tool:browser' });
    expect(approvalPolicyDecision(approvals, [requirement], context, WORKSPACE, true, 'other-job'))
      .toEqual({ kind: 'denied', allowPath: 'approvals.jobs.other-job.allow' });
    expect(approvalPolicyDecision(approvals, [requirement], context, WORKSPACE, true))
      .toEqual({ kind: 'denied', allowPath: 'approvals.unattended_bus.allow' });
  });

  it('returns the matching job/bus policy path in an unattended approval refusal', () => {
    const job = unattendedConversations.mark('strata-job', {
      jobId: 'strata-update',
      jobName: 'Strata update',
    });
    const bus = unattendedConversations.mark('agent-bus-turn');
    try {
      const jobDecision = createChatRuleApproval({
        getConfig: () => configFor({ jobs: { 'strata-update': { allow: [] } } }),
        workspaceRoot: WORKSPACE,
        home: HOME,
        platform: 'win32',
        recordAutoGate: vi.fn(),
      }).decide(call({
        id: 'strata-job',
        title: 'Job',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
      }));
      const busDecision = createChatRuleApproval({
        getConfig: () => configFor({ unattended_bus: { allow: [] } }),
        workspaceRoot: WORKSPACE,
        home: HOME,
        platform: 'win32',
        recordAutoGate: vi.fn(),
      }).decide(call({
        id: 'agent-bus-turn',
        title: 'Bus',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
      }));
      expect(jobDecision).toEqual({
        kind: 'policy-denied',
        allowPath: 'approvals.jobs.strata-update.allow',
        key: 'cross_chat',
      });
      expect(busDecision).toEqual({
        kind: 'policy-denied',
        allowPath: 'approvals.unattended_bus.allow',
        key: 'cross_chat',
      });
      expect(
        new ToolApprovalPolicyDenied('message_chat', {
          job: true,
          allowPath: 'approvals.jobs.strata-update.allow',
          approvalKey: 'cross_chat',
        }).message,
      ).toContain('Add cross_chat to approvals.jobs.strata-update.allow in ~/.forge/policy.yaml.');
    } finally {
      job.dispose();
      bus.dispose();
    }
  });

  it('lists global and current-workspace rules, omitting rules for other projects', () => {
    const approvals: ForgeConfig['approvals'] = {
      always: [
        { key: 'cross_chat' },
        { key: 'tool:browser', workspace: WORKSPACE },
        { key: 'tool:terminal', workspace: OTHER_WORKSPACE },
      ],
    };
    expect(approvalPolicyLinesForWorkspace(approvals, WORKSPACE, context)).toEqual([
      'Always in this project: messages to other chats  (cross_chat)',
      'Always in this project: the browser tool  (tool:browser)',
    ]);
  });

  it('includes applicable project policy entries in the sidebar /approvals response', async () => {
    const conversation: ConversationRuntime = {
      id: 'chat-list',
      title: 'Test',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      approval_rules: ['cross_chat'],
    };
    const posted: HostToWebview[] = [];
    await handleApprovalsSlashCommand({
      getActiveConv: () => conversation,
      getConversations: () => [conversation],
      persistSession: () => undefined,
      getConfig: () => configFor({ always: [{ key: 'tool:browser', workspace: WORKSPACE }] }),
      workspaceRoot: WORKSPACE,
      post: (message) => posted.push(message),
    });
    expect(posted.find((message) => message.type === 'notice')).toMatchObject({
      message: expect.stringContaining('Always in this project: the browser tool'),
    });
  });
});

describe('owner-clicked Always in this project writes', () => {
  let directory: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('writes approvals.always through the routed config writer and dedupes the same project key', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-approval-policy-'));
    const configPath = path.join(directory, 'config.yaml');
    const policyPath = path.join(directory, 'policy.yaml');
    fs.writeFileSync(
      configPath,
      'models:\n  - name: test\n    provider: ollama\n    endpoint: http://127.0.0.1:11434\n' +
        'active_model: test\n',
    );
    fs.writeFileSync(policyPath, 'permissions:\n  approval_timeout_minutes: 15\n');

    const writerOptions = { policyPath };
    expect(writeApprovalAlways(configPath, ['cross_chat'], WORKSPACE, writerOptions)).toEqual({
      kind: 'written',
    });
    expect(writeApprovalAlways(configPath, ['cross_chat'], WORKSPACE, writerOptions)).toEqual({
      kind: 'written',
    });
    expect(loadConfig(directory, { policyPath }).approvals?.always).toEqual([
      { key: 'cross_chat', workspace: WORKSPACE },
    ]);
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('approvals:');
  });

  it('does not invent a timeout default or write when the project/config is unavailable', () => {
    expect(
      ForgeConfigSchema.parse({
        models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
        active_model: 'm',
      }).permissions?.approval_timeout_minutes,
    ).toBeUndefined();
    expect(writeApprovalAlways(undefined, ['cross_chat'], WORKSPACE).kind).toBe('failed');
    expect(writeApprovalAlways('config.yaml', ['cross_chat'], undefined).kind).toBe('failed');
  });

  it('rejects policy approval keys that try to cover a drive root', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-approval-policy-invalid-'));
    const configPath = path.join(directory, 'config.yaml');
    const policyPath = path.join(directory, 'policy.yaml');
    fs.writeFileSync(
      configPath,
      'models:\n  - name: test\n    provider: ollama\n    endpoint: http://127.0.0.1:11434\n' +
        'active_model: test\n',
    );
    fs.writeFileSync(
      policyPath,
      'approvals:\n  always:\n    - key: rdelete:C:/\n      workspace: N:/ws/project\n',
    );
    expect(() => loadConfig(directory, { policyPath })).toThrow(
      /approvals\.always\.0\.key: rdelete:C:\/.*root/u,
    );
  });
});
