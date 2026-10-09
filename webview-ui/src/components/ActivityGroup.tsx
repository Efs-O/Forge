import React from 'react';
import type { ActivityGroupItem } from '../activityRows';

export interface ActivityGroupProps {
  items: ActivityGroupItem[];
  /** This group holds the last message and its conversation is streaming. */
  live: boolean;
  /** The conversation is streaming (passed through to each `ActivityRow`). */
  streaming: boolean;
}

/** One grouped run of steps (plan § Proposal B). Phase 3 replaces this stub. */
export function ActivityGroup(_props: ActivityGroupProps): React.ReactElement {
  return <div className="activity-group" />;
}
