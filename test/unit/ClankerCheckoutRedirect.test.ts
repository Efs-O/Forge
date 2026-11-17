import { describe, expect, it, vi } from 'vitest';

// `shellTool` reaches the workspace folder through `vscode`, and the approval
// service builds its output channel at import. Both are mocked before the
// imports below run (`vi.mock` is hoisted), so this file needs no VS Code window.
vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }] },
  commands: { executeCommand: vi.fn() },
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      clear: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
}));

import type { HostToWebview } from '../../src/sidebar/messageBridge';
import { ToolApprovalService, type ToolApprovalSink } from '../../src/sidebar/ToolApprovalService';
import { approvalCallOptions } from '../../src/sidebar/approvalCallOptions';
import type { ToolApprovalCallOptions } from '../../src/sidebar/toolApprovalOutcome';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import { ToolApprovalRefusal } from '../../src/tools/toolContract';
import { makeShellTool } from '../../src/tools/shellTool';
import { getBuiltinDenyList } from '../../src/tools/DenyList';
import { makeRestoreFileTool } from '../../src/tools/gitTools';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import type { ToolApprovalMetadata } from '../../src/tools/ToolRegistry';

/**
 * Phase 1 of `docs/plans/CLANKER_CHECKOUT_REDIRECT_PLAN.md`.
 *
 * A Clanker lane that undid eight hand-planted mutations with `git checkout --
 * <file>` on 2026-11-17 raised eight owner cards, waiting 1.3 s to 198 s each,
 * and any one of them could have stalled the lane for hours with the owner away.
 * That rule's own alternative is `restore_file`, which snapshots every path it
 * overwrites, so the card protects nothing Clanker is not already allowed to do
 * — it only stalls the run. The rule is refused at once and points at the tool.
 *
 * Every other deny-list stop keeps its card: this is one rule's answer, not the
 * deny list's. The commands go through the REAL classifier and the REAL
 * metadata-to-options seam, so a rule that loses its name or its redirect flag
 * fails here instead of quietly becoming a card again.
 */

const CHAT = 'clanker-redirect-chat';
const CHECKOUT_RULE = 'git checkout/restore discarding work';

/** The whole refusal, exactly as the plan pins it. `shell` is the tool name. */
const EXACT_REFUSAL =
  'Clanker: "shell" was not run: git checkout/restore discarding work. Use this instead: To undo edits you made yourself, use edit_file; to put a tracked path back the way git has it, use restore_file. Forge snapshots the file first, so Undo can bring it back. No approval card was raised.';

const shellTool = makeShellTool({ platform: 'linux', bashPath: '/bin/bash' });

/** What the real gate raises for a command, and what the queue is handed. */
function gateFor(command: string): {
  metadata: ToolApprovalMetadata | undefined;
  options: ToolApprovalCallOptions;
} {
  const metadata = shellTool.approval?.({ command });
  return { metadata, options: approvalCallOptions(metadata, { card: true }, undefined, 'none') };
}

function harness() {
  const posted: HostToWebview[] = [];
  const resolved: string[] = [];
  const sink: ToolApprovalSink = {
    requested: () => undefined,
    resolved: (event) => resolved.push(event.reason),
  };
  const service = new ToolApprovalService(
    (message) => posted.push(message),
    () => ({}) as never,
    undefined,
    () => undefined,
  );
  service.addSink(sink);
  return {
    service,
    resolved,
    cards: () =>
      posted.filter((message) => message.type === 'confirmRequest') as Extract<
        HostToWebview,
        { type: 'confirmRequest' }
      >[],
  };
}

/** Settle a gated call without a card ever being answerable. */
async function settle(
  service: ToolApprovalService,
  command: string,
  conversationId: string,
): Promise<{ error: Error | undefined; outcome: 'approved' | string }> {
  const { metadata, options } = gateFor(command);
  const result = await service
    .request(
      'shell',
      metadata?.detail ?? command,
      metadata?.dangerous === true,
      conversationId,
      undefined,
      options,
    )
    .then((outcome) => ({ error: undefined, outcome: outcome as string }))
    .catch((error: Error) => ({ error, outcome: 'rejected' }));
  return result;
}

describe('a Clanker chat redirects a deny-list file checkout instead of carding it', () => {
  it('refuses with the exact wording the plan pins, and no card', async () => {
    const { service, cards } = harness();
    service.setClankerMode(CHAT, true);
    const { error } = await settle(service, 'git checkout -- src/a.ts', CHAT);
    expect(error, 'the call was refused').toBeInstanceOf(ToolApprovalRefusal);
    expect(error?.message).toBe(EXACT_REFUSAL);
    expect(cards()).toHaveLength(0);
  });

  it.each([
    ['git checkout -- src/a.ts', 'a path with the separator'],
    ['git checkout .', 'the whole tree'],
    ['git restore src/a.ts', 'git restore'],
  ])('refuses %s (%s) at once, naming both sanctioned tools', async (command) => {
    const { service, cards, resolved } = harness();
    service.setClankerMode(CHAT, true);
    const { error } = await settle(service, command, CHAT);
    expect(error, command).toBeInstanceOf(ToolApprovalRefusal);
    expect(error?.message, command).toContain(`was not run: ${CHECKOUT_RULE}.`);
    for (const tool of ['edit_file', 'restore_file'])
      expect(error?.message, `${command}: ${tool}`).toContain(tool);
    expect(error?.message, command).toContain('No approval card was raised.');
    expect(cards(), command).toHaveLength(0);
    // Nothing answered it for the chat either: the refusal is the whole event.
    expect(resolved, command).toEqual([]);
  });

  it.each([
    'git reset --hard',
    'git clean -fd',
    'git push --force',
    'rm -rf build',
  ])('still cards %s in the same Clanker chat', async (command) => {
    const { service, cards, resolved } = harness();
    service.setClankerMode(CHAT, true);
    const { metadata, options } = gateFor(command);
    const pending = service.request(
      'shell',
      metadata?.detail ?? command,
      metadata?.dangerous === true,
      CHAT,
      undefined,
      options,
    );
    const card = cards()[0];
    if (card?.type !== 'confirmRequest') throw new Error(`${command} raised no card`);
    expect(card.isDangerous, command).toBe(true);
    expect(card.detail, command).toContain('Matched rule:');
    expect(cards(), command).toHaveLength(1);
    expect(resolved, command).toEqual([]);
    service.cancelConversation(CHAT);
    await expect(pending).resolves.toBe('declined');
  });

  it('still cards the checkout for a chat that has Clanker off', async () => {
    const { service, cards } = harness();
    const { metadata, options } = gateFor('git checkout -- src/a.ts');
    const pending = service.request(
      'shell',
      metadata?.detail ?? '',
      metadata?.dangerous === true,
      'attended-chat',
      undefined,
      options,
    );
    const card = cards()[0];
    if (card?.type !== 'confirmRequest') throw new Error('an attended chat raised no card');
    expect(card.detail).toContain('Matched rule:');
    service.cancelConversation('attended-chat');
    await expect(pending).resolves.toBe('declined');
  });

  it('refuses it in an unattended run exactly as before', async () => {
    const { service, cards } = harness();
    const marker = unattendedConversations.mark('job-9', { jobId: 'j9', jobName: 'Nightly' });
    service.setClankerMode('job-9', true);
    try {
      const { error } = await settle(service, 'git checkout -- src/a.ts', 'job-9');
      expect(error?.name).toBe('ToolApprovalPolicyDenied');
      expect(error?.message).toContain('unattended: dangerous tool denied by policy');
      expect(error?.message).toContain('Stop and report RESULT: failed');
      expect(cards()).toHaveLength(0);
    } finally {
      marker.dispose();
    }
  });

  it.each([
    ['git restore --staged src/a.ts', 'not deny-listed'],
  ])('still allows %s (%s) with no card', async (command) => {
    const { service, cards } = harness();
    service.setClankerMode(CHAT, true);
    const { metadata, options } = gateFor(command);
    expect(options.gateKind, command).not.toBe('denyList');
    expect(options.clankerRedirect, command).toBeUndefined();
    const outcome = await service.request(
      'shell',
      metadata?.detail ?? command,
      metadata?.dangerous === true,
      CHAT,
      undefined,
      options,
    );
    expect(outcome).toBe('approved');
    expect(cards()).toHaveLength(0);
  });

  it('leaves restore_file and edit_file alone under Clanker', async () => {
    const restore = makeRestoreFileTool().approval?.({ paths: ['src/a.ts'] });
    expect(restore?.gateKind).toBeUndefined();
    const { service, cards } = harness();
    service.setClankerMode(CHAT, true);
    const outcome = await service.request(
      'restore_file',
      restore?.detail ?? '',
      restore?.dangerous === true,
      CHAT,
      undefined,
      approvalCallOptions(restore, { card: true }, undefined, 'none'),
    );
    expect(outcome).toBe('approved');
    expect(cards()).toHaveLength(0);
    // `edit_file` has no gate of its own, so nothing can card it.
    expect(makeEditFileTool().approval).toBeUndefined();
  });

  it('names the rule to the queue as a typed field, not by its card text', () => {
    const { metadata, options } = gateFor('git checkout -- src/a.ts');
    expect(metadata?.denyRule).toBe(CHECKOUT_RULE);
    expect(metadata?.clankerRedirect).toBe(true);
    expect(options.denyRule).toBe(CHECKOUT_RULE);
    expect(options.clankerRedirect).toBe(true);
    // A rule that does not redirect still reaches the queue with its name, so a
    // card can be answered exactly as before.
    const reset = gateFor('git reset --hard');
    expect(reset.metadata?.denyRule).toBe('git reset --hard');
    expect(reset.options.clankerRedirect).toBeUndefined();
  });

  it('marks exactly one deny-list rule as redirected, and it is the checkout', () => {
    const redirecting = getBuiltinDenyList().filter((rule) => rule.clankerRedirect === true);
    expect(redirecting.map((rule) => rule.description)).toEqual([CHECKOUT_RULE]);
    // The redirect is only safe where the alternative is checkpointed, so the
    // rule has to keep naming both sanctioned tools.
    for (const tool of ['edit_file', 'restore_file'])
      expect(redirecting[0]?.alternative, tool).toContain(tool);
  });
});
