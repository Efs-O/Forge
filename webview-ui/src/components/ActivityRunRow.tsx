import React from 'react';
import { stepMessages, type ActivityStep } from '../activityRows';
import { runLabel } from '../activityRuns';
import { useDisclosure } from '../disclosureState';
import { sameRowList } from '../messageOps';
import { ActivityRow } from './ActivityRow';

export interface ActivityRunRowProps {
  toolName: string;
  steps: ActivityStep[];
  streaming: boolean;
}

/** One row for back-to-back successful calls of one tool; expands to the steps. */
function ActivityRunRowView({
  toolName,
  steps,
  streaming,
}: ActivityRunRowProps): React.ReactElement {
  const [manualOpen, setManualOpen] = useDisclosure('run', stepMessages(steps[0]!)[0]!.id);
  const open = manualOpen ?? false;
  const label = runLabel(toolName, steps);

  return (
    <div className="activity-row activity-run">
      <button
        type="button"
        className="activity-row-header"
        aria-expanded={open}
        onClick={() => setManualOpen(!open)}
      >
        <span className="activity-row-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="tool-row-status is-ok" title="completed">
          ✓
        </span>
        <span className="activity-row-name">{toolName}</span>
        <span className="activity-row-repeat">×{steps.length}</span>
        {label && <span className="activity-row-detail">· {label}</span>}
      </button>
      {open && (
        <div className="activity-row-body">
          {steps.map((step) => (
            <ActivityRow key={stepMessages(step)[0]!.id} step={step} streaming={streaming} />
          ))}
        </div>
      )}
    </div>
  );
}

export const ActivityRunRow = React.memo(
  ActivityRunRowView,
  (previous, next) =>
    previous.streaming === next.streaming &&
    previous.toolName === next.toolName &&
    sameRowList(previous.steps.flatMap(stepMessages), next.steps.flatMap(stepMessages)),
);
