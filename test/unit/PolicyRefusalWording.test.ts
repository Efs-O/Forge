import { afterEach, describe, expect, it } from 'vitest';
import {
  SECRET_TAINT_REFUSAL_REASON,
  ToolApprovalPolicyDenied,
  toolApprovalResult,
} from '../../src/sidebar/toolApprovalOutcome';
import { isFailureResult, neverRanResult } from '../../src/sidebar/toolResultView';
import { getBuiltinDenyList } from '../../src/tools/DenyList';
import { fetchApprovalFor } from '../../src/tools/fetchHostApprovals';
import { clearConversationSecretState, markConversationReadSecret } from '../../src/tools/exfilTaint';
import { secretCardReason, secretDeclineHint } from '../../src/tools/secretPaths';

/**
 * The wording a refused approval carries to the model, pinned against the gates
 * that write its parts — the deny list's own rule names, the fetch gate's
 * reason, the secret gate's hint — rather than against strings this file made
 * up. A refusal that the model cannot parse is a refusal the model ignores: the
 * `git checkout` that came back as another `git checkout` was refused in words
 * that were technically correct and unreadable.
 *
 * Two of the 0.17.91 re-run's findings are fixed here. Finding 5a: a deny-list
 * rule name ran straight into "Use this instead", because a rule description is
 * not a sentence and the refusal joined the two with nothing but a space.
 * Finding 1's message half: the refusal for a secret-tainted fetch blamed a
 * missing judge when the reason was the secret this chat had read, while a judge
 * was sitting right there configured. The `/clanker` variants of these refusals
 * are gone, and so are the three tails that explained them: a chat with Clanker on
 * gets a card for anything it does not answer with a key, so the only run that
 * still refuses with no card is one with nobody in it at all. What is asserted
 * here is the wording that survives, pinned against the gates that write its parts.
 */

const SECRET_PATTERN = '**/.env';

/** Every `Use this instead:` has to start its own sentence. "…discarding work
 *  Use this instead: edit_file" reads as one clause, and the model has to guess
 *  where the reason ended before it can act on the alternative. */
function assertSentences(message: string, label: string): void {
  const hits = [...message.matchAll(/(.{0,24})Use this instead:/g)];
  expect(hits.length, `${label}: names an alternative`).toBeGreaterThan(0);
  for (const hit of hits) {
    const before = (hit[1] ?? '').trimEnd();
    expect(before, `${label}: "…${before}Use this instead:"`).toMatch(/[.?!]["')\]]?$/u);
  }
  expect(message, label).not.toMatch(/\w Use this instead:/);
}

describe('a refusal by policy reads as sentences', () => {
  afterEach(() => clearConversationSecretState());

  const denyRules = getBuiltinDenyList().filter((rule) => rule.class === 'dangerous');

  it('every deny-list refusal, in every autonomous mode', () => {
    expect(denyRules.length, 'the deny list has dangerous rules').toBeGreaterThan(0);
    for (const rule of denyRules) {
      // The card's own reason line, exactly as `shellTool.ts` builds it:
      // `Matched rule: ` plus the rule's description, which is not a sentence.
      const cardReason = `Matched rule: ${rule.description}`;
      assertSentences(
        new ToolApprovalPolicyDenied('shell', {
          job: true,
          why: cardReason,
          alternative: rule.alternative,
        }).message,
        `unattended job / ${rule.description}`,
      );
      assertSentences(
        new ToolApprovalPolicyDenied('shell', {
          job: false,
          why: cardReason,
          alternative: rule.alternative,
        }).message,
        `unattended bus turn / ${rule.description}`,
      );
    }
  });

  it('an unattended secret-path gate', () => {
    const message = new ToolApprovalPolicyDenied('read_file', {
      job: true,
      why: secretCardReason(SECRET_PATTERN),
      alternative: secretDeclineHint(SECRET_PATTERN),
    }).message;
    assertSentences(message, 'secret gate, unattended');
    expect(message).toContain(`reads a secret path (${SECRET_PATTERN}). Use this instead:`);
    expect(message).toContain('Stop and report RESULT: failed');
  });

  it('a fetch after a secret read, in both unattended halves', () => {
    markConversationReadSecret('wording-conv');
    const approval = fetchApprovalFor('https://collector.example.net/', undefined, 'wording-conv');
    if (!approval || approval.gateKind !== 'taintGate')
      throw new Error('the taint rule did not raise the card this test is about');
    if (!approval.declineHint) throw new Error('the taint card carries no alternative');
    // The hint is the gate's own and does not end with a full stop, so it has
    // to be closed before the tail starts: the unattended refusal used to read
    // "…taints the whole chat Stop and report RESULT".
    expect(approval.declineHint.endsWith('.')).toBe(false);
    const busTurn = new ToolApprovalPolicyDenied('web_fetch', {
      job: false,
      why: SECRET_TAINT_REFUSAL_REASON,
      alternative: approval.declineHint,
    }).message;
    assertSentences(busTurn, 'taint gate, unattended bus turn');
    expect(busTurn).toContain(`${approval.declineHint}. Nobody is present to approve it`);
    const job = new ToolApprovalPolicyDenied('web_fetch', {
      job: true,
      why: SECRET_TAINT_REFUSAL_REASON,
      alternative: approval.declineHint,
    }).message;
    assertSentences(job, 'taint gate, unattended job');
    expect(job).toContain(`${approval.declineHint}. Stop and report RESULT:`);
    // The reason is the secret, in the agent's own words, and nothing blames a
    // judge that would not have seen the secret either way.
    expect(job).toContain(SECRET_TAINT_REFUSAL_REASON);
    expect(job).not.toContain('not configured');
  });
});

describe('a decline by a human says no, and nothing else', () => {
  /*
   * The 0.17.117 live test: the owner declined a recursive delete of a folder,
   * the result came back `User declined: shell — use this instead: delete_file`,
   * and the agent read the hint as an instruction and deleted the folder with
   * `delete_file` anyway. A person who says no means no, so the alternative now
   * travels only on the card (`approvalCallOptions.ts`), where it can change what
   * the owner clicks, and in the unattended refusal above, where nobody is at the
   * card to say no at all.
   */
  it('a declined card names no alternative and tells the agent not to work around it', () => {
    const declined = toolApprovalResult('shell', 'declined');
    expect(declined).toContain('User declined: shell');
    expect(declined).toContain('do not do the same thing another way');
    expect(declined).not.toContain('use this instead');
    // The gate's own hint must not leak back in through any route.
    expect(declined).not.toContain('delete_file');
    // The result grew, and the failure prefix it is judged by did not move: a
    // declined call still counts as a call that did not run.
    expect(isFailureResult(declined)).toBe(true);
    expect(neverRanResult(declined)).toBe(true);
  });

  it('a timeout keeps its instruction and names no alternative either', () => {
    const timedOut = toolApprovalResult('shell', { kind: 'timeout', minutes: 30 });
    expect(timedOut).toContain('Not run: nobody answered the approval for shell within 30 min.');
    expect(timedOut).toContain('Do not retry it this turn.');
    expect(timedOut).not.toContain('use this instead');
    // `Not run:` is the never-ran prefix (`toolResultView.ts`); it was never
    // part of `isFailureResult`, and this fix does not quietly change that.
    expect(neverRanResult(timedOut)).toBe(true);
    expect(isFailureResult(timedOut)).toBe(false);
  });

  it('says no card was shown for a carried-over timeout', () => {
    const carried = toolApprovalResult('write_file', {
      kind: 'timeout',
      minutes: 15,
      carried: true,
    });
    expect(carried).toBe(
      'Not run: an approval earlier in this turn went unanswered for 15 min, so no card was shown for this write_file call. Do not retry it this turn. Finish the remaining steps, then list this one as not done in your final reply.',
    );
  });
});
