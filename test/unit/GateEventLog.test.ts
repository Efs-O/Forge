import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// `vscode` resolves to `test/support/vscode.ts` for the whole suite, so this
// file needs no mock of its own: the stub already answers
// `createOutputChannel` and `getExtension` the way a test host does.

import {
  GateEventLog,
  GATE_REASON_MAX_CHARS,
  buildGateRefusalRow,
  classifyGateRefusal,
  type GateEventCause,
  type GateEventRow,
} from '../../src/sidebar/gateEventLog';
import { SECRET_TAINT_REFUSAL_REASON } from '../../src/sidebar/toolApprovalOutcome';
import { ownerOnlySetFor, ownerOnlyToolRefusal, ownerOnlyWriteTargetFor } from '../../src/tools/ownerPaths';
import { resolveWorkspacePath } from '../../src/util/WorkspacePaths';
import type {
  ToolApprovalRequestEvent,
  ToolApprovalResolvedEvent,
} from '../../src/sidebar/toolApprovalEvents';
import { parseSessionLogRows } from '../../src/sessions/sessionLogRows';
import { SessionLogCoordinator } from '../../src/sidebar/SessionLogCoordinator';
import { SessionLogger, sessionsDirectory } from '../../src/sidebar/SessionLogger';
import type { ChatMessage } from '../../src/llm/types';

const OWNER_ONLY_REFUSAL =
  "Error: edit_file: .forge/config.yaml is part of Forge's own files (the config file " +
  'Forge loads its settings from, and everything under `~/.forge/`).';
const OUTSIDE_WORKSPACE_REFUSAL =
  'Error: Path is outside the workspace: V:/Maya/maya-maya-s24.json (and outside ' +
  'extra_file_roots: N:/models)';

/** A card, in the shape the approval queue emits. `approved` is present because
 *  the resolved event extends the request event, not because the ledger reads it.
 */
function card(over: Partial<ToolApprovalRequestEvent> = {}): ToolApprovalRequestEvent {
  return {
    id: 'card-1',
    toolName: 'shell',
    detail: 'writes outside the workspace',
    dangerous: false,
    conversationId: 'chat-1',
    ...over,
  };
}

/** A ledger with a clock the test moves, so a wait is measured, not slept. */
function harness(startMs = 1_000_000) {
  let nowMs = startMs;
  const rows: GateEventRow[] = [];
  const log = new GateEventLog({
    write: (row) => rows.push(row),
    now: () => nowMs,
  });
  return {
    rows,
    log,
    advance(ms: number) {
      nowMs += ms;
    },
    requested(event: ToolApprovalRequestEvent) {
      log.requested(event);
    },
    resolved(event: ToolApprovalResolvedEvent) {
      log.resolved(event);
    },
  };
}

function resolvedOf(
  event: ToolApprovalRequestEvent,
  reason: ToolApprovalResolvedEvent['reason'],
  extra: Partial<ToolApprovalResolvedEvent> = {},
): ToolApprovalResolvedEvent {
  return {
    ...event,
    approved: reason !== 'cancelled',
    decision: reason === 'resolved' ? 'approve' : 'decline',
    reason,
    ...extra,
  };
}

describe('the gate ledger', () => {
  const summarizedCalls = [
    [
      'manage_jobs',
      JSON.stringify({ action: 'create', definition: { name: 'Nightly' } }),
      'Create job "Nightly".',
    ],
    [
      'message_chat',
      JSON.stringify({ action: 'send', to: 'target', message: 'a build note' }),
      'Send message to "target": "a build note"',
    ],
    [
      'ask_agent',
      JSON.stringify({ agent: 'codex', message: 'Review the patch.' }),
      'Ask codex: "Review the patch."',
    ],
  ] as const;

  it.each(summarizedCalls)('records a readable auto reason for %s', (tool, detail, expected) => {
    const h = harness();
    h.log.autoApproved({ toolName: tool, detail, answeredBy: 'clanker' });
    expect(h.rows[0]!.reason).toBe(expected);
  });

  it.each(summarizedCalls)('records a readable card reason for %s', (tool, detail, expected) => {
    const h = harness();
    const event = card({ toolName: tool, detail });
    h.requested(event);
    h.resolved(resolvedOf(event, 'resolved'));
    expect(h.rows[0]!.reason).toBe(expected);
  });

  it('gives auto gates without supplied detail a human-readable operation summary', () => {
    const h = harness();
    h.log.autoApproved({ toolName: 'message_chat', answeredBy: 'clanker' });
    h.log.autoApproved({ toolName: 'ask_agent', answeredBy: 'clanker' });
    expect(h.rows[0]!.reason).toBe('Send a message to another Forge chat.');
    expect(h.rows[1]!.reason).toBe('Ask a linked CLI agent.');
  });

  it('writes one row per card, timed from the card itself', () => {
    const h = harness();
    h.requested(card());
    h.advance(90_000);
    h.resolved(resolvedOf(card(), 'resolved'));
    expect(h.rows).toHaveLength(1);
    const row = h.rows[0]!;
    expect(row.kind).toBe('card');
    expect(row.answered_by).toBe('owner');
    expect(row.tool).toBe('shell');
    expect(row.conversation_id).toBe('chat-1');
    expect(row.wait_ms).toBe(90_000);
    expect(row.reason).toBe('writes outside the workspace');
  });

  it('records a card nobody answered as a timeout, never as an approval', () => {
    const h = harness();
    h.requested(card({ conversationId: 'chat-2' }));
    h.advance(5 * 60_000);
    h.resolved(resolvedOf(card({ conversationId: 'chat-2' }), 'timeout'));
    expect(h.rows[0]!.kind).toBe('card');
    expect(h.rows[0]!.answered_by).toBe('timeout');
    expect(h.rows[0]!.wait_ms).toBe(5 * 60_000);
  });

  it('records the keys an Allow for this chat card accepted', () => {
    const h = harness();
    const event = card({
      allowForChat: { keys: ['cross_chat', 'net:github.com'], label: 'messages to other chats and any request to github.com' },
    });
    h.requested(event);
    h.resolved(
      resolvedOf(event, 'resolved', {
        approved: true,
        decision: 'allowChat',
      }),
    );
    expect(h.rows[0]!.allowed_for_chat).toBe('cross_chat, net:github.com');
  });

  it('reads a gate row an older Forge labelled `stand_in`, without throwing', () => {
    // The ledger writes two kinds now, but session logs on disk still hold rows
    // from the third one it used to write. The shared log reader takes every line
    // as an opaque record, so an old row costs a session restore nothing rather
    // than breaking it — and `answered_by` stays whatever that older Forge wrote.
    const rows = parseSessionLogRows(
      '{"type":"gate","kind":"stand_in","tool":"shell","answered_by":"stand_in","answered_by_model":"x"}',
      'legacy-log',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('gate');
    expect(rows[0]!.kind).toBe('stand_in');
  });

  it('records a turn that stopped with its card still open as a cancel', () => {
    const h = harness();
    const event = card();
    h.requested(event);
    h.advance(30_000);
    h.resolved(resolvedOf(event, 'cancelled'));
    expect(h.rows[0]!.answered_by).toBe('cancel');
    expect(h.rows[0]!.wait_ms).toBe(30_000);
  });

  it('still answers a card raised before this ledger existed, without a fake wait', () => {
    // A window reload rebuilds the sinks while the approval queue keeps its
    // pending cards. Losing the row entirely would make the wait unmeasurable.
    const h = harness();
    h.resolved(resolvedOf(card(), 'resolved'));
    const row = h.rows[0]!;
    expect(row.answered_by).toBe('owner');
    expect(row.raised_ms).toBeUndefined();
    expect(row.wait_ms).toBeUndefined();
  });

  it('writes nothing for a chat that met no gate', () => {
    const h = harness();
    expect(buildGateRefusalRow('read_file', 'exit 0 · 0.1 s\nno matches here', 'chat-1')).toBeUndefined();
    expect(
      buildGateRefusalRow(
        'shell',
        'User declined: shell. The user said no to this action: do not do the same thing another way (another tool, command or path) unless they ask for it.',
        'chat-1',
      ),
    ).toBeUndefined();
    expect(h.rows).toHaveLength(0);
  });

  it('names the wall that stopped the call', () => {
    expect(classifyGateRefusal(OWNER_ONLY_REFUSAL)).toBe('owner_only');
    expect(classifyGateRefusal(OUTSIDE_WORKSPACE_REFUSAL)).toBe('outside_workspace');
    expect(classifyGateRefusal(`Error: ${SECRET_TAINT_REFUSAL_REASON}`)).toBe('secret_taint');
    expect(
      classifyGateRefusal('Error: web_fetch: the redirect goes to code.claude.com, a host not approved in this chat'),
    ).toBe('host_gate');
    expect(classifyGateRefusal('Error: shell: system power command (deny list) — Use sleep_computer')).toBe(
      'deny_list',
    );
    const row = buildGateRefusalRow('edit_file', OWNER_ONLY_REFUSAL, 'chat-3');
    expect(row?.kind).toBe('refusal');
    expect(row?.cause).toBe('owner_only');
    expect(row?.conversation_id).toBe('chat-3');
  });

  it('records an unattended refusal, and names which wall it was', () => {
    // Word for word from the live ask-once run of 2026-11-03, where five of six
    // refusals wrote no gate row at all: the `unattended:` prefix was not a prefix
    // this reader knew, and no signature matched the shell deny-list wording.
    const live: Array<[string, GateEventCause]> = [
      [
        'unattended: approval key denied by policy: "web_fetch". Add net:example.com to approvals.unattended_bus.allow in ~/.forge/policy.yaml.',
        'policy_deny',
      ],
      [
        'unattended: dangerous tool denied by policy: "shell". Matched rule: recursive Remove-Item.',
        'deny_list',
      ],
      [
        'Error: shell: system power command (deny list) — Use sleep_computer for a supported sleep request.',
        'deny_list',
      ],
      [
        "Error: edit_file: C:/Users/x/.forge/policy.yaml is part of Forge's own files",
        'owner_only',
      ],
    ];
    for (const [text, cause] of live) expect(classifyGateRefusal(text), text).toBe(cause);
    // A call that ran, and a card the owner answered, are still not refusals: the
    // second is recorded once by the sink, and counting it here would double it.
    expect(classifyGateRefusal('exit 0 · 0.1 s\nno matches here')).toBeUndefined();
    expect(classifyGateRefusal('User declined: web_fetch')).toBeUndefined();
  });

  it("pins each guard's real refusal wording to its cause", () => {
    // The point is the breakage direction: reword a guard and THIS test goes
    // red, instead of the ledger quietly dropping rows for a wall it stopped
    const sources: Array<[string, string]> = [
      ['../../src/tools/ownerPaths.ts', "is part of Forge's own files"],
      ['../../src/util/WorkspacePaths.ts', 'Path is outside the workspace'],
      ['../../src/tools/fetchHostApprovals.ts', 'a host not approved in this chat'],
      ['../../src/sidebar/toolApprovalOutcome.ts', 'dangerous tool denied by policy'],
    ];
    for (const [rel, wording] of sources) {
      const source = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(source, `${rel} still says "${wording}"`).toContain(wording);
      expect(classifyGateRefusal(`Error: ${wording}`), wording).toBeDefined();
    }
    // Two of them are proved end to end, built by the guard itself rather than
    // quoted by the test, so a change in the guard's own text moves both.
    const set = ownerOnlySetFor({
      configPath: 'C:/Users/someone/AppData/Roaming/Code/User/globalStorage/forge-llm/config.yaml',
      workspaceRoot: 'N:/Apps/Forge',
      home: 'C:/Users/someone',
      platform: 'win32',
    });
    const hit = ownerOnlyWriteTargetFor('~/.forge/config.yaml', set, 'N:/Apps/Forge');
    expect(hit).toBeDefined();
    const refusal = ownerOnlyToolRefusal('edit_file', hit!);
    expect(classifyGateRefusal(`Error: ${refusal}`)).toBe('owner_only');
    let outside = '';
    try {
      // Both roots under the OS temp folder, so this is outside on the Linux and
      // macOS runners too — a hard-coded `V:/` is a relative path there.
      resolveWorkspacePath(path.resolve(os.tmpdir(), 'forge-gate-pin-outside', 'x.json'), {
        workspaceRoot: path.resolve(os.tmpdir(), 'forge-gate-pin-workspace'),
        mustBeInsideWorkspace: true,
      });
    } catch (err) {
      outside = String(err);
    }
    expect(outside).toMatch(/outside the workspace/i);
    expect(classifyGateRefusal(`Error: ${outside}`)).toBe('outside_workspace');
  });

  it('does not call a declined card a refusal, so a decline is counted once', () => {
    expect(classifyGateRefusal('User declined: write_file')).toBeUndefined();
    expect(classifyGateRefusal('Not run: nobody answered the approval for write_file within 5 min')).toBeUndefined();
  });

  it('keeps the reason to one capped line, so a refusal cannot echo a file', () => {
    const long = `Error: shell: refuses to change Forge's own files (${'.forge/tmp/'.padEnd(900, 'x')})`;
    const row = buildGateRefusalRow('shell', long, 'chat-1');
    expect(row?.reason?.length).toBeLessThanOrEqual(GATE_REASON_MAX_CHARS + 1);
    expect(row?.reason).not.toContain('\n');
  });

  it('drops a gate row whose chat is gone instead of guessing where it belongs', () => {
    const written: GateEventRow[] = [];
    const coordinator = new SessionLogCoordinator(
      () => ({ conversations: [], activeConversationId: undefined } as never),
      () => ({}) as never,
    );
    const row = buildGateRefusalRow('edit_file', OWNER_ONLY_REFUSAL, 'gone-chat')!;
    coordinator.logGate('gone-chat', row);
    coordinator.logGate('', row);
    expect(written).toHaveLength(0);
    // Nothing was appended for an unknown conversation: the sessions directory
    // gained no file named after a chat that does not exist.
    expect(fs.existsSync(path.join(sessionsDirectory(), 'gone-chat.jsonl'))).toBe(false);
  });
});

describe('a refusal is recorded next to the tool row it stopped', () => {
  const sessionId = `gate-event-test-${process.pid}-${Date.now()}`;
  const filePath = path.join(sessionsDirectory(), `${sessionId}.jsonl`);

  it('appends a gate row for the guard refusal and not for an ordinary result', () => {
    const logger = new SessionLogger(sessionId, 'gate ledger test', 'test-model', {});
    const messages: ChatMessage[] = [
      { role: 'tool', content: OUTSIDE_WORKSPACE_REFUSAL, tool_call_id: 'c1', name: 'write_file' },
      { role: 'tool', content: 'exit 0 · 0.1 s\nwritten', tool_call_id: 'c2', name: 'write_file' },
    ] as unknown as ChatMessage[];
    logger.flush(messages, 'test-model');
    const rows = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"type":"gate"'))
      .map((line) => JSON.parse(line) as GateEventRow);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cause).toBe('outside_workspace');
    expect(rows[0]!.tool).toBe('write_file');
    // The refusal row carries the conversation it happened in, so a reader never
    // has to guess which chat was blocked.
    expect(rows[0]!.conversation_id).toBe(sessionId);
    expect(rows[0]!.model).toBe('test-model');
  });

  it('does not write the same refusal twice when the same messages are flushed again', () => {
    const logger = new SessionLogger(sessionId, 'gate ledger test', 'test-model', {});
    const messages: ChatMessage[] = [
      { role: 'tool', content: OUTSIDE_WORKSPACE_REFUSAL, tool_call_id: 'c1', name: 'write_file' },
      { role: 'tool', content: 'exit 0 · 0.1 s\nwritten', tool_call_id: 'c2', name: 'write_file' },
    ] as unknown as ChatMessage[];
    logger.flush(messages, 'test-model');
    const rows = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"type":"gate"'));
    expect(rows).toHaveLength(1);
  });

  it('cleans up the file it created', () => {
    fs.rmSync(filePath, { force: true });
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
