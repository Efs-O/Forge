import { toolNameAndDetail, type AppMessage } from './messageOps';
import { displayDetail, type ActivityGroupItem, type ActivityStep } from './activityRows';

/** A group item after folding: back-to-back calls of one tool share a row. */
export type FoldedItem =
  | ActivityGroupItem
  | { kind: 'run'; toolName: string; steps: ActivityStep[] };

const RUN_LABEL_PARTS = 3;

function onlyTool(step: ActivityStep): AppMessage | undefined {
  const tools = step.attempts.at(-1)?.tools;
  return tools?.length === 1 ? tools[0] : undefined;
}

function toolOf(step: ActivityStep): string | undefined {
  const tool = onlyTool(step);
  return tool ? (tool.toolName ?? toolNameAndDetail(tool).name) : undefined;
}

/**
 * Only quiet steps fold: an edit, a failure, a recovered retry or a call still
 * running keeps its own row, so it stays visible at a glance.
 */
function foldable(step: ActivityStep): boolean {
  const tool = onlyTool(step);
  if (!tool || step.diffs.length > 0) return false;
  if (tool.toolIsError || tool.toolResultTotal === undefined) return false;
  return step.attempts.every((attempt) => attempt.tools.every((t) => !t.toolIsError));
}

/** Folds each maximal run of 2+ foldable steps calling the same tool. */
export function foldRuns(items: ActivityGroupItem[]): FoldedItem[] {
  const out: FoldedItem[] = [];
  let run: ActivityStep[] = [];
  let runTool: string | undefined;

  const flush = (): void => {
    if (run.length > 1) out.push({ kind: 'run', toolName: runTool!, steps: run });
    else out.push(...run.map((step): FoldedItem => ({ kind: 'step', step })));
    run = [];
    runTool = undefined;
  };

  for (const item of items) {
    const tool = item.kind === 'step' && foldable(item.step) ? toolOf(item.step) : undefined;
    if (item.kind === 'step' && tool !== undefined) {
      if (tool !== runTool) flush();
      run.push(item.step);
      runTool = tool;
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

/**
 * What a folded run did, in a few words: the distinct programs for `shell`
 * (`grep, sed`), the distinct targets for anything else.
 */
export function runLabel(toolName: string, steps: ActivityStep[]): string {
  const parts: string[] = [];
  for (const step of steps) {
    const tool = onlyTool(step)!;
    const target = tool.toolTarget ?? toolNameAndDetail(tool).detail;
    const shown = toolName === 'shell' ? displayDetail(target).split(/\s+/u)[0] : target;
    if (shown && !parts.includes(shown)) parts.push(shown);
  }
  const head = parts.slice(0, RUN_LABEL_PARTS).join(', ');
  return parts.length > RUN_LABEL_PARTS ? `${head}, …` : head;
}
