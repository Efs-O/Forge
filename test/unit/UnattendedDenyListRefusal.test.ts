import { describe, expect, it, vi } from 'vitest';

// `shellTool` pulls in `execHelpers`, which reads the workspace folder from
// `vscode`, and the approval service reaches the logger through an output
// channel built at import. Both are mocked before the imports below run (`vi.mock`
// is hoisted), so this file needs no VS Code window.
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
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import type { ToolApprovalCallOptions } from '../../src/sidebar/toolApprovalOutcome';
import { makeShellTool } from '../../src/tools/shellTool';
import { getBuiltinDenyList } from '../../src/tools/DenyList';
import type { ToolApprovalMetadata } from '../../src/tools/ToolRegistry';

/**
 * Lane B item 5 of `docs/plans/OWNER_GUARDS_PLAN.md`: a deny-list `dangerous`
 * command in an autonomous run must come back as a refusal the agent can act on,
 * not as a card. A lane that ran `git checkout` on 2026-10-27 got a card nobody
 * answered and hung 2 h — with `permissions.approval_timeout_minutes` unset an
 * unanswered card waits forever, so "ask the owner" is not an answer in a run
 * that has no owner present.
 *
 * A chat with Clanker on is no longer treated as one of those runs. It has a
 * human, in the tab the mode was armed in, so the deny list's card opens there
 * and waits like any other card, timed out when the owner configured
 * `permissions.approval_timeout_minutes` and held when they did not — which is
 * the honest answer to the 2026-10-27 hang: the timeout is the thing that ends
 * the wait, not a refusal that arrives before the owner could see the call.
 * One rule is the exception, and it is the rule's own choice (`clankerRedirect`
 * in `DenyList.ts`): a file checkout is refused at once naming `restore_file`,
 * because that tool does the same overwrite behind a checkpoint and the card
 * only ever stalled a lane the owner was not watching.
 * `ClankerCheckoutRedirect.test.ts` pins that refusal; this file keeps the card
 * for every rule that still asks, and the unattended refusal for all of them.
 *
 * The commands go through the REAL classifier (`makeShellTool().approval()`), so
 * a rule that loses its `gateKind: 'denyList'`, or its sanctioned alternative,
 * fails here rather than quietly becoming a hang again.
 */

const shellTool = makeShellTool({ platform: 'linux', bashPath: '/bin/bash' });

/** The command, plus the tool its refusal has to name. */
const DENIED: Array<[string, string[]]> = [
  ['git checkout -- src/a.ts', ['edit_file', 'restore_file']],
  ['git restore src/a.ts', ['edit_file', 'restore_file']],
  ['git reset --hard', ['restore_file', 'edit_file']],
  ['git clean -fd', ['delete_file']],
  ['rm -rf build', ['delete_file']],
];

/** What `approval()` returns for a command, as a card would be raised. */
function metadataFor(command: string): ToolApprovalMetadata {
  const metadata = shellTool.approval?.({ command });
  if (!metadata) throw new Error(`${command} raised no approval at all`);
  return metadata;
}

/** The commands whose rule still stops for the owner in a Clanker chat. The two
 *  checkout spellings are not among them: that rule answers itself with a
 *  refusal naming the sanctioned tool, pinned in `ClankerCheckoutRedirect.test.ts`. */
const CARDED_IN_CLANKER: Array<[string, string[]]> = [
  ['git reset --hard', ['restore_file', 'edit_file']],
  ['git clean -fd', ['delete_file']],
  ['rm -rf build', ['delete_file']],
];

/** `ToolDispatch.ts`'s metadata-to-call-options mapping, copied so the gate the
 *  tool raises is the gate the service sees. The same shape is pinned against the
 *  real dispatcher by `ToolDispatch.test.ts` ('Safer way: Use restore_file'). */
function optionsFor(metadata: ToolApprovalMetadata): ToolApprovalCallOptions {
  return {
    ...(metadata.gateKind ? { gateKind: metadata.gateKind } : {}),
    ...(metadata.cardReason ? { cardReason: metadata.cardReason } : {}),
    ...(metadata.declineHint ? { alternative: metadata.declineHint } : {}),
    ...(metadata.denyRule ? { denyRule: metadata.denyRule } : {}),
    ...(metadata.clankerRedirect ? { clankerRedirect: metadata.clankerRedirect } : {}),
  };
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

describe('a deny-list dangerous command in an autonomous run', () => {
  it('refuses every one of them at once in an unattended turn, with no card', async () => {
    for (const [command, tools] of DENIED) {
      const { service, cards } = harness();
      const marker = unattendedConversations.mark('job-1', { jobId: 'j1', jobName: 'Nightly' });
      try {
        const metadata = metadataFor(command);
        expect(metadata.dangerous, command).toBe(true);
        const error = await service
          .request('shell', metadata.detail ?? '', true, 'job-1', undefined, optionsFor(metadata))
          .then(() => undefined)
          .catch((err: Error) => err);
        expect(error, command).toBeInstanceOf(Object);
        expect((error as Error).name, command).toBe('ToolApprovalPolicyDenied');
        const message = (error as Error).message;
        expect(message, command).toContain('unattended');
        expect(message, command).toContain('Use this instead');
        for (const tool of tools) expect(message, `${command}: ${tool}`).toContain(tool);
        expect(cards(), command).toHaveLength(0);
      } finally {
        marker.dispose();
      }
    }
  });

  /** A chat with Clanker on is not a run with nobody in it: the mode was armed in a
   *  tab that has a person looking at it, so the deny list's card opens and waits
   *  instead of refusing. This is the 2026-10-27 hang answered the honest way — the
   *  timeout the owner configures ends the wait, and the owner still saw the call. */
  it('gives them their card in a Clanker chat instead of refusing them', async () => {
    for (const [command, tools] of CARDED_IN_CLANKER) {
      const { service, cards, resolved } = harness();
      service.setClankerMode('chat-1', true);
      const metadata = metadataFor(command);
      const pending = service.request(
        'shell',
        metadata.detail ?? '',
        true,
        'chat-1',
        undefined,
        optionsFor(metadata),
      );
      const card = cards()[0];
      if (card?.type !== 'confirmRequest')
        throw new Error(`${command} was refused without a card in a Clanker chat`);
      expect(card.isDangerous, command).toBe(true);
      expect(card.detail, command).toContain('Matched rule:');
      expect(card.detail, command).toContain('Safer way:');
      // Nothing answered it for the chat, and no refusal reached the agent ahead of
      // the card: the card is the only thing that can answer, exactly as attended.
      expect(resolved, command).toEqual([]);
      expect(cards(), command).toHaveLength(1);
      // The sanctioned tool still travels with the gate, so a decline says what to
      // do next in the same words the unattended refusal carries.
      for (const tool of tools)
        expect(optionsFor(metadata).alternative ?? '', `${command}: ${tool}`).toContain(tool);
      service.cancelConversation('chat-1');
      await expect(pending).resolves.toBe('declined');
      expect(resolved, command).toEqual(['cancelled']);
    }
  });

  /** The half that must NOT change: attended mode keeps its card for every one
   *  of these commands, and a person at the sidebar still decides. The card
   *  stays live until they do — nothing answers it for them.
   */
  it('still raises a card in attended mode for every command it refuses elsewhere', async () => {
    vi.useFakeTimers();
    for (const [command] of DENIED) {
      const { service, cards } = harness();
      const metadata = metadataFor(command);
      const pending = service.request(
        'shell',
        metadata.detail ?? '',
        true,
        'chat-7',
        undefined,
        optionsFor(metadata),
      );
      const card = cards()[0];
      if (card?.type !== 'confirmRequest')
        throw new Error(`${command} raised no card while attended`);
      expect(card.isDangerous, command).toBe(true);
      expect(card.detail, command).toContain('Matched rule:');
      expect(card.detail, command).toContain('Safer way:');
      // Half an hour of waiting changes nothing: the card is still the only
      // one, and it is still the owner's to answer.
      vi.advanceTimersByTime(30 * 60_000);
      expect(cards(), command).toHaveLength(1);
      // Close this gate so the next command gets a card of its own; cancelling
      // also clears its timeout timer.
      service.cancelConversation('chat-7');
      await expect(pending).resolves.toBe('declined');
    }
    vi.useRealTimers();
  });

  /** The data behind the routing: every dangerous entry on the deny list carries
   *  the autonomous-run answer, so a new destructive rule cannot be added as a
   *  card-only gate by accident. */
  it('marks every dangerous deny-list entry as refused in an autonomous run', () => {
    for (const rule of getBuiltinDenyList()) {
      if (rule.class !== 'dangerous') continue;
      expect(rule.gateKind, rule.description).toBe('denyList');
    }
  });

  it('names the sanctioned tool in the alternative of each refused command', () => {
    for (const [command, tools] of DENIED) {
      // Which rule matched is proved by the routing tests above; what is pinned
      // here is that the refusal for THIS command names a tool the agent can
      // actually call — the trap `delete_file` went uncalled across 3,000 calls
      // because a bare refusal named nothing.
      const metadata = metadataFor(command);
      expect(metadata.declineHint, command).toBeDefined();
      for (const tool of tools)
        expect(metadata.declineHint ?? '', `${command}: ${tool}`).toContain(tool);
    }
  });

  /**
   * `docs/reports/V1_SECURITY_LIVE_TEST.md` re-run, finding 5a: a deny-list rule
   * description is not a sentence, so the refusal read "…git checkout/restore
   * discarding work Use this instead: …" and the model had to guess where the
   * reason ended. The rule's own description is quoted here, because that is the
   * string `shellTool.ts` puts in `cardReason`. The fix is punctuation only, so
   * the rest of the message — which the agent already acts on — is quoted whole
   * as well. The `/clanker` half is a refusal again for this one rule only, so
   * both wordings are asserted here: the unattended refusal carries the rule as
   * the card names it (`cardReason`), and the Clanker refusal carries the rule's
   * own name, since a decision that read the card's text back would break the
   * day the card is reworded. Every other deny-list rule still opens its card.
   */
  it('ends the matched rule before naming the alternative, in both refusals it writes', async () => {
    const RULE_SENTENCE = 'Matched rule: git checkout/restore discarding work. Use this instead:';
    const metadata = metadataFor('git checkout -- src/a.ts');

    const unattended = harness();
    const marker = unattendedConversations.mark('job-11', { jobId: 'j11', jobName: 'Nightly' });
    let message = 'nothing';
    try {
      message = await unattended.service
        .request('shell', metadata.detail ?? '', true, 'job-11', undefined, optionsFor(metadata))
        .then(() => 'approved')
        .catch((err: Error) => err.message);
    } finally {
      marker.dispose();
    }
    expect(message).toContain(RULE_SENTENCE);
    expect(message).not.toMatch(/\w Use this instead:/);

    const clanker = harness();
    clanker.service.setClankerMode('chat-12', true);
    const clankerMessage = await clanker.service
      .request(
        'shell',
        metadata.detail ?? '',
        true,
        'chat-12',
        undefined,
        optionsFor(metadata),
      )
      .then(() => 'approved')
      .catch((err: Error) => err.message);
    // The `/clanker` half of the finding is a refusal again for this one rule, so
    // the rule name still has to end before the alternative in the refusal too.
    expect(clankerMessage).toContain('git checkout/restore discarding work. Use this instead:');
    expect(clankerMessage).not.toMatch(/\w Use this instead:/);
    for (const tool of ['edit_file', 'restore_file'])
      expect(clankerMessage, tool).toContain(tool);
    expect(clanker.cards()).toHaveLength(0);
  });
});
