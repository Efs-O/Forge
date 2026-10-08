import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  PendingAgentReplies,
  PENDING_AGENT_REPLY_TTL_MS,
} from '../../src/agentLinks/pendingAgentReplies';

const sender = {
  kind: 'claude' as const,
  sessionId: '00000000-0000-4000-8000-000000000031',
  title: 'Review chat',
};

describe('pending inbound agent replies', () => {
  it('persists admission before a turn, then finishes and removes in order', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pending-reply-'));
    try {
      let now = 100;
      const pending = new PendingAgentReplies(root, () => now, 321);
      const admitted = pending.create(sender, 'conversation-1', '/workspace');
      expect(pending.list()).toEqual([admitted]);
      expect(fs.readdirSync(path.join(root, 'pending-replies'))).toEqual([
        `${admitted.exchangeId}.json`,
      ]);

      now += 1;
      expect(pending.markRunning(admitted.exchangeId).state).toBe('running');
      const finished = pending.markFinished(admitted.exchangeId, {
        kind: 'completed',
        text: 'answer',
      });
      expect(finished.outcome?.text).toBe('answer');
      pending.remove(admitted.exchangeId);
      expect(pending.list()).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('expires a record at 24 hours and ignores an interrupted temporary write', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pending-ttl-'));
    try {
      let now = 5_000;
      const pending = new PendingAgentReplies(root, () => now, 322);
      const record = pending.create(sender, 'conversation-2', '/workspace');
      fs.writeFileSync(path.join(root, 'pending-replies', 'partial.json.tmp'), '{');
      now += PENDING_AGENT_REPLY_TTL_MS;
      expect(pending.expired(record)).toBe(true);
      expect(pending.list()).toEqual([record]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
