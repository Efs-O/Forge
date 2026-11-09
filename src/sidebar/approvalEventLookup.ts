/** Read through pending approval state without creating another store. */
export function approvalEventForConversation<T extends { conversationId?: string }, Event>(
  active: T | null,
  queued: readonly T[],
  conversationId: string,
  eventOf: (item: T) => Event,
): Event | undefined {
  const item =
    active?.conversationId === conversationId
      ? active
      : queued.find((card) => card.conversationId === conversationId);
  return item ? eventOf(item) : undefined;
}
