import { describe, expect, it } from 'vitest';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';

describe('unattended conversation registry', () => {
  it('marks and removes one conversation without affecting another', () => {
    const first = 'unattended-registry-first';
    const second = 'unattended-registry-second';
    const firstMarker = unattendedConversations.mark(first);
    const secondMarker = unattendedConversations.mark(second);

    expect(unattendedConversations.has(first)).toBe(true);
    expect(unattendedConversations.has(second)).toBe(true);

    firstMarker.dispose();
    firstMarker.dispose();
    expect(unattendedConversations.has(first)).toBe(false);
    expect(unattendedConversations.has(second)).toBe(true);

    secondMarker.dispose();
    expect(unattendedConversations.has(second)).toBe(false);
  });
});
