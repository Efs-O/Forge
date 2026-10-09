import React from 'react';
import type { ActivityStep } from '../activityRows';

export interface ActivityRowProps {
  step: ActivityStep;
  /** The conversation is streaming: a pending call forces the step open. */
  streaming: boolean;
}

/** One compact step row (plan § Proposal A). Phase 2 replaces this stub. */
export function ActivityRow(_props: ActivityRowProps): React.ReactElement {
  return <div className="activity-row" />;
}
