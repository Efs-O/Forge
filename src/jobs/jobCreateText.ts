import type { ForgeConfig } from '../config/types';
import { jobDefaultModel } from '../config/jobsSchema';
import type { Job } from './jobSchema';

/** Confirmation text for a job create, including whether it is enabled. */
export function jobCreateText(
  job: Pick<Job, 'name' | 'enabled' | 'action'>,
  id: string,
  firstRun: Date,
  config: ForgeConfig,
): string {
  const created = job.enabled
    ? `Created job "${job.name}" [${id}]. First run: ${firstRun.toLocaleString()}.`
    : `Created job "${job.name}" [${id}]. It is disabled, so it will not run until you resume it.`;
  return `${created}${jobsModelSentence(config, job.action)}`;
}

/** The create confirmation's sentence about which model the agent will run on.
 *
 * A `jobs.default_model` naming a model that has been deleted is NOT rethrown
 * here: the job is already saved and its first run seeded by the time this
 * sentence is built, so a throw would report a half-written file as a failed
 * create. The runner names that failure at the job start instead
 * (`AgentTaskRunner.run`), and the user still needs to see it now — this is the
 * moment they could fix the field.
 */
function jobsModelSentence(config: ForgeConfig, action: Job['action']): string {
  if (action?.kind !== 'agent_task') return '';
  if (action.model) return ` Its agent runs on ${action.model}.`;
  try {
    return ` Its agent runs on jobs.default_model (${jobDefaultModel(config) ?? 'unset'}).`;
  } catch {
    return (
      ` Its agent runs on jobs.default_model (${config.jobs?.default_model ?? 'unset'}). ` +
      'That model is no longer in config.yaml, so this job will fail until ' +
      '`jobs.default_model` names a configured model.'
    );
  }
}
