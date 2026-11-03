import type { ConversationPersisted, ConversationRuntime } from './sessionTypes';

/** Recover one grace timestamp from an optional persisted conversation field. */
export function persistedRetentionState(
  conversation: Pick<ConversationPersisted, 'retention_activity_at' | 'keep_open'>,
  now = Date.now(),
): Pick<ConversationRuntime, 'retention_activity_at' | 'keep_open'> {
  const activityAt = conversation.retention_activity_at;
  return {
    retention_activity_at:
      typeof activityAt === 'number' && Number.isFinite(activityAt) && activityAt <= now
        ? activityAt
        : now,
    keep_open: conversation.keep_open === true,
  };
}

/** Keep both retention fields on each existing persisted conversation record. */
export function runtimeRetentionState(
  conversation: Pick<ConversationRuntime, 'retention_activity_at' | 'keep_open'>,
): Pick<ConversationPersisted, 'retention_activity_at' | 'keep_open'> {
  return {
    retention_activity_at: conversation.retention_activity_at ?? Date.now(),
    keep_open: conversation.keep_open === true,
  };
}
