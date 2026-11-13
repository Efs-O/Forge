import { describe, expect, it } from 'vitest';
import {
  approvalCarryKey,
  approvalGrantNote,
  formatApprovalWait,
  toolApprovalResult,
} from '../../src/sidebar/toolApprovalOutcome';

/**
 * What a gated call says about the human it waited for (BUG-14). The lab's student
 * read `[host example.org was new to this chat; approved for the rest of it]` as
 * automatic and reported "auto-approved, no card" to the supervisor after waiting
 * 5m09s for one — so the attribution and the wait belong in the tool result, not
 * only in the gate ledger nobody but the auditor reads.
 */
describe('approval wait text', () => {
  it('formats a wait the way a card answer reads in a sentence', () => {
    expect(formatApprovalWait(9_000)).toBe('9s');
    expect(formatApprovalWait(251_000)).toBe('4m11s');
    expect(formatApprovalWait(300_000)).toBe('5m');
    expect(formatApprovalWait(750_000)).toBe('12m30s');
    expect(formatApprovalWait(0)).toBe('0s');
  });

  it('names the human and the wait, and stays silent when nobody waited', () => {
    expect(approvalGrantNote(251_000)).toBe('[you approved this call after 4m11s]');
    expect(approvalGrantNote(undefined)).toBe('');
  });

  it('words a carried timeout as the same approval, not the whole turn', () => {
    expect(toolApprovalResult('manage_jobs', { kind: 'timeout', minutes: 10, carried: true })).toBe(
      'Not run: this manage_jobs call needs the approval that went unanswered earlier in this turn (10 min), so no new card was shown. Do not retry it this turn. Finish the remaining steps, then list this one as not done in your final reply.',
    );
  });
});

/**
 * An unanswered card silences the approval it was asked for and nothing else, so
 * the identity of "the same approval" has to be stable across calls.
 */
describe('approvalCarryKey', () => {
  it('uses the keys the card offered to allow, in any order', () => {
    const a = approvalCarryKey('shell', { allowForChat: { keys: ['exec:a', 'exec:b'], label: 'x' } });
    const b = approvalCarryKey('shell', { allowForChat: { keys: ['exec:b', 'exec:a'], label: 'x' } });
    expect(a).toBe(b);
    expect(a).toBe('keys:exec:a|exec:b');
  });

  it('separates two tools that share no key', () => {
    expect(approvalCarryKey('schedule_wake')).not.toBe(approvalCarryKey('manage_jobs'));
    expect(approvalCarryKey('message_chat', { gateKind: 'taintGate' })).toBe(
      'tool:message_chat:gate:taintGate',
    );
    expect(approvalCarryKey('message_chat')).not.toBe(
      approvalCarryKey('message_chat', { gateKind: 'taintGate' }),
    );
  });
});
