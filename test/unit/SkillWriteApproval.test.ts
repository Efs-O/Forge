/**
 * A write into `~/.forge/skills` asks the owner on every call, in every mode.
 *
 * Skills are open to the file tools by design (the owner edits them without a
 * config entry), but a skill is the one open area whose content is later EXECUTED:
 * a skill's scripts are run by CLI agents with full permissions. So the write that
 * changes a skill is worth a card, and an answer that must not be automated —
 * Clanker included, and an unattended run refuses it rather than running it.
 *
 * Everything else in the two open areas keeps today's behaviour: a memory file and
 * a workspace write still run with no card, and a skill READ still asks nothing.
 *
 * The probe lives under the real `~/.forge/skills`, because the question is asked
 * against this machine's home (`toolApprovalEvaluation.ts`), so a fixture home
 * could not prove the rule. Every path it creates is removed afterwards.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { makeReadFileTool, makeWriteFileTool } from '../../src/tools/builtinTools';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { makeDeleteFileTool } from '../../src/tools/fileEditTools';
import { openForgeFileRoots, SKILL_WRITE_REASON } from '../../src/tools/ownerPathsOpen';
import { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import { ToolApprovalService } from '../../src/sidebar/ToolApprovalService';
import { createChatRuleApproval } from '../../src/sidebar/chatRuleApproval';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { ToolFailureTracker } from '../../src/tools/StripTools';
import type { ToolPermission } from '../../src/tools/ToolRegistry';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    openTextDocument: vi.fn().mockResolvedValue({}),
    asRelativePath: vi.fn((value: string) => value),
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
  commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
  Uri: { file: vi.fn((value: string) => ({ fsPath: value })) },
}));

const CONV = 'skill-write-chat';
const WORKSPACE = path.join(os.tmpdir(), 'forge-skill-write-approval-ws');
const HOME = os.homedir();
const PROBE_DIR = path.join(HOME, '.forge', 'skills', '.approval-probe');
const SKILL_FILE = path.join(PROBE_DIR, 'SKILL.md');
const MEMORY_DIR = path.join(HOME, '.forge', 'memories', 'skill-write-probe');
const MEMORY_FILE = path.join(MEMORY_DIR, 'note.md');
const allowed = new Set<ToolPermission>(['read', 'write', 'delete']);

function harness(options: { clanker?: boolean } = {}) {
  const registry = new ToolRegistry();
  const extraRoots = (): readonly string[] => openForgeFileRoots();
  registry.register(makeWriteFileTool(extraRoots));
  registry.register(makeEditFileTool(extraRoots));
  registry.register(makeDeleteFileTool(extraRoots));
  registry.register(makeReadFileTool());

  const posted: HostToWebview[] = [];
  const autoAnswers: Array<{ answeredBy: string }> = [];
  const service = new ToolApprovalService(
    (message) => posted.push(message),
    () => ({ postMessage: vi.fn() }) as never,
  );
  service.addSink({
    requested: () => undefined,
    resolved: () => undefined,
    autoApproved: (event) => autoAnswers.push(event),
  });
  service.setClankerMode(CONV, options.clanker === true);

  const chatRuleApproval = createChatRuleApproval({
    getConfig: () => undefined,
    workspaceRoot: WORKSPACE,
    home: HOME,
    platform: process.platform,
    ...(options.clanker
      ? { clankerMode: (conversationId: string) => conversationId === CONV }
      : {}),
    recordAutoGate: () => undefined,
    lookup: (conversationId: string) =>
      conversationId === CONV
        ? { id: CONV, title: 'probe', createdAt: 1, updatedAt: 2, messages: [] }
        : undefined,
    persist: () => undefined,
  });

  const dispatch = new ToolDispatch(
    registry,
    { snapshotBefore: vi.fn(), readSnapshotContent: vi.fn() } as unknown as CheckpointStack,
    { markPending: vi.fn(), clearPending: vi.fn() } as unknown as KeepUndoCodeLensProvider,
    {
      recordNativeParseFailure: vi.fn(),
      reset: vi.fn(),
      shouldStrip: vi.fn().mockReturnValue(false),
    } as unknown as ToolFailureTracker,
    (message: HostToWebview) => posted.push(message),
    (toolName, detail, dangerous, conversationId, signal, callOptions) =>
      service.request(toolName, detail, dangerous, conversationId, signal, callOptions),
    { apply: vi.fn() } as unknown as DiffDecorations,
    chatRuleApproval,
  );

  const cards = (): Array<Extract<HostToWebview, { type: 'confirmRequest' }>> =>
    posted.filter((message) => message.type === 'confirmRequest');
  const call = (name: string, args: Record<string, unknown>): Promise<ChatMessage[]> => {
    const messages: ChatMessage[] = [];
    const toolCall: ToolCall = {
      id: `call-${name}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    };
    const pending = dispatch.dispatch([toolCall], allowed, messages, CONV);
    return new Promise<ChatMessage[]>((resolve, reject) => {
      pending.then(() => resolve(messages), reject);
    });
  };
  return { cards, call, service, autoAnswers, posted };
}

/** Wait until exactly this many cards have opened, and hand back the newest one. */
async function openedCard(probe: ReturnType<typeof harness>, count: number) {
  await vi.waitFor(() => expect(probe.cards()).toHaveLength(count));
  return probe.cards()[count - 1]!;
}

/** Resolve the one card this call has opened, so the round can finish. */
async function answer(
  probe: ReturnType<typeof harness>,
  decision: 'approve' | 'decline',
): Promise<void> {
  const card = await openedCard(probe, 1);
  probe.service.resolve(card.id, decision);
}

beforeAll(() => {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  fs.writeFileSync(SKILL_FILE, 'the skill as it was\n');
  // The memories area has to exist before a write into it is admitted. The file
  // tools real-path each open root (`~/.forge/memories` is one) and a root that is
  // not on disk "contributes nothing", so the write is refused as outside the
  // workspace and the file is never created — measured on the GitHub runners, where
  // nothing had ever made that folder. Every real machine has it, because activation
  // creates a per-workspace folder under it; a clean runner does not.
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE, '.git'), { recursive: true });
  (vscode.workspace.workspaceFolders as unknown as Array<{ uri: { fsPath: string } }>).splice(
    0,
    Infinity,
    { uri: vscode.Uri.file(WORKSPACE) },
  );
});

afterAll(() => {
  fs.rmSync(PROBE_DIR, { recursive: true, force: true });
  fs.rmSync(MEMORY_DIR, { recursive: true, force: true });
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(SKILL_FILE, 'the skill as it was\n');
  fs.rmSync(MEMORY_FILE, { force: true });
});

describe('a write into ~/.forge/skills', () => {
  it('opens a card that names why, and offers nothing to allow', async () => {
    const probe = harness();
    const run = probe.call('write_file', { path: SKILL_FILE, content: 'a new skill\n' });

    await vi.waitFor(() => expect(probe.cards()).toHaveLength(1));
    const card = probe.cards()[0]!;
    expect(card.cardReason).toBe(SKILL_WRITE_REASON);
    expect(card).not.toHaveProperty('allowForChat');
    expect(card).not.toHaveProperty('alwaysInProject');

    probe.service.resolve(card.id, 'decline');
    await run;
    expect(fs.readFileSync(SKILL_FILE, 'utf8')).toBe('the skill as it was\n');
  });

  it('opens its card in a Clanker chat, and Clanker leaves it to the owner', async () => {
    const probe = harness({ clanker: true });
    const run = probe.call('write_file', { path: SKILL_FILE, content: 'a new skill\n' });

    await vi.waitFor(() => expect(probe.cards()).toHaveLength(1));
    expect(probe.cards()[0]!.cardReason).toBe(SKILL_WRITE_REASON);
    expect(probe.autoAnswers).toHaveLength(0);

    await answer(probe, 'approve');
    await run;
    expect(fs.readFileSync(SKILL_FILE, 'utf8')).toBe('a new skill\n');
  });

  it('asks again after the owner answered the first one', async () => {
    const probe = harness();
    const first = probe.call('write_file', { path: SKILL_FILE, content: 'first\n' });
    const card = await openedCard(probe, 1);
    probe.service.resolve(card.id, 'approve');
    await first;
    expect(probe.cards()).toHaveLength(1);

    const second = probe.call('edit_file', {
      path: SKILL_FILE,
      old_str: 'first',
      new_str: 'second',
    });
    const again = await openedCard(probe, 2);
    expect(again.cardReason).toBe(SKILL_WRITE_REASON);
    probe.service.resolve(again.id, 'approve');
    await second;
    expect(fs.readFileSync(SKILL_FILE, 'utf8')).toBe('second\n');
  });

  it('asks for a skill delete and a skill edit too', async () => {
    const probe = harness();
    const removal = probe.call('delete_file', { path: SKILL_FILE, to_trash: false });
    await vi.waitFor(() => expect(probe.cards()).toHaveLength(1));
    expect(probe.cards()[0]!.cardReason).toBe(SKILL_WRITE_REASON);
    probe.service.resolve(probe.cards()[0]!.id, 'decline');
    await removal;
    expect(fs.existsSync(SKILL_FILE)).toBe(true);

    const edit = probe.call('edit_file', {
      path: SKILL_FILE,
      old_str: 'as it was',
      new_str: 'as it is',
    });
    await vi.waitFor(() => expect(probe.cards()).toHaveLength(2));
    expect(probe.cards()[1]!.cardReason).toBe(SKILL_WRITE_REASON);
    probe.service.resolve(probe.cards()[1]!.id, 'decline');
    await edit;
    expect(fs.readFileSync(SKILL_FILE, 'utf8')).toBe('the skill as it was\n');
  });

  it('is refused by an unattended run, naming why', async () => {
    const marker = unattendedConversations.mark(CONV, { jobId: 'j1', jobName: 'probe' });
    try {
      const probe = harness();
      const messages = await probe.call('write_file', {
        path: SKILL_FILE,
        content: 'a new skill\n',
      });
      expect(probe.cards()).toHaveLength(0);
      const text = JSON.stringify(messages);
      const refusal = messages.map((message) => String(message.content ?? '')).join('\n');
      expect(text).toContain(SKILL_WRITE_REASON);
      expect(refusal).toContain('unattended: dangerous tool denied by policy: "write_file".');
      expect(fs.readFileSync(SKILL_FILE, 'utf8')).toBe('the skill as it was\n');
    } finally {
      marker.dispose();
    }
  });
});

describe('the rest of the open areas are unchanged', () => {
  it('writes a memory file with no card', async () => {
    const probe = harness();
    const messages = await probe.call('write_file', {
      path: MEMORY_FILE,
      content: 'a note\n',
    });
    expect(probe.cards()).toHaveLength(0);
    expect(fs.readFileSync(MEMORY_FILE, 'utf8')).toBe('a note\n');
    expect(JSON.stringify(messages)).not.toContain(SKILL_WRITE_REASON);
  });

  it('writes a workspace file with no card', async () => {
    const probe = harness();
    const target = path.join(WORKSPACE, 'workspace-write.txt');
    const messages = await probe.call('write_file', { path: target, content: 'ordinary\n' });
    expect(probe.cards()).toHaveLength(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('ordinary\n');
    expect(JSON.stringify(messages)).not.toContain(SKILL_WRITE_REASON);
  });

  it('reads a skill file with no card', async () => {
    const probe = harness();
    const messages = await probe.call('read_file', { path: SKILL_FILE });
    expect(probe.cards()).toHaveLength(0);
    expect(JSON.stringify(messages)).toContain('the skill as it was');
  });
});
