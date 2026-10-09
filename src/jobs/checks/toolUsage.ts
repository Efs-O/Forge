import * as os from 'os';
import * as path from 'path';
import type { CheckResult } from './checkTypes';
import { previousCompleteLocalDay, writeToolUsageReports } from '../../sessions/toolUsage';

/** Recompute local session counts; this writes files, so changed stays false and notify never fires. */
export function toolUsageCheck(
  _lastObservation: string | null,
  options: { now?: Date; sessionDirectory?: string; outputDirectory?: string } = {},
): CheckResult {
  const forgeDirectory = path.join(os.homedir(), '.forge');
  const endDay = previousCompleteLocalDay(options.now ?? new Date());
  const reports = writeToolUsageReports(
    options.sessionDirectory ?? path.join(forgeDirectory, 'sessions'),
    options.outputDirectory ?? path.join(forgeDirectory, 'tool-usage'),
    endDay,
  );
  const lastDate = reports.at(-1)?.date ?? endDay;
  const target = reports.find((report) => report.date === lastDate);
  let sessions = 0;
  let calls = 0;
  for (const build of target?.builds ?? [])
    for (const model of build.models) {
      sessions += model.sessions;
      calls += model.tools.reduce((sum, tool) => sum + tool.calls, 0);
    }
  // This check writes about 5 KB per day locally. It always reports unchanged: files only, no job messages.
  return {
    observation: lastDate,
    changed: false,
    summary: `wrote through ${lastDate}: ${sessions} session${sessions === 1 ? '' : 's'}, ${calls} tool calls`,
  };
}
