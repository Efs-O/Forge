/**
 * The deterministic half of a compaction summary.
 *
 * `compactionPrompt.ts` owns the text sent to the summarizer and the judgement
 * of what comes back; this file owns the facts that need no model at all: what
 * the agent actually did, read off the tool calls. It is rendered under a
 * header saying Forge recorded it, which is the entire reason a resumed agent
 * trusts it without re-verifying — so everything here must be true or absent,
 * never optimistic.
 *
 * Deliberately dependency-free: no `vscode`, no child processes, nothing but
 * the messages passed in. `repoSnapshot.ts` owns the half that must shell out.
 *
 * Measured on session 39c9bf42: two of six changed files never reached the
 * model because the summary source cap dropped them, so no summarizer could
 * have named them. This block is derived from ALL the summarized messages.
 */

import type { ChatMessage } from '../llm/types';
import { isFailureResult } from './toolResultView';
import { TOOL_INTERRUPTED_RESULT } from './sessionPersistence';

/**
 * Tools that MODIFY a file, and the argument keys that carry the path.
 *
 * Taken from the schemas in `src/tools/`, not guessed: `edit_file` spells it
 * `filepath` while everything else uses `path`, and missing that spelling
 * silently zeroed this list on a session with 106 edits in it.
 */
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_line_edits',
  'append_file',
  'insert_code',
  'delete_file',
  'move_file',
  'format_file',
  'rename_symbol',
  'create_file',
]);
const PATH_KEYS = ['path', 'filepath', 'file_path', 'source', 'destination'];

/** Tools that run something. `query_powershell` is the registered name — there
 *  is no `safe_powershell`. */
const COMMAND_TOOLS = new Set([
  'exec_command',
  'run_tests',
  'run_build',
  'query_powershell',
  'run_terminal',
]);

/**
 * `run_terminal` pastes into a VS Code terminal and returns before the user has
 * even pressed Enter, so its result can never carry an outcome. Recording it as
 * done would be a lie this block's header vouches for.
 */
const NEVER_COMPLETES = new Set(['run_terminal']);

/** Cap per section, so recorded facts cannot crowd out the summary. */
const RECORDED_ENTRIES_MAX = 24;

/** ToolBudget refusals. Neither carries the `Error:` prefix `isFailureResult`
 *  looks for, and both mean the call never ran. */
const BUDGET_REFUSAL = /^Budget exhausted:/;
const UNAVAILABLE_REFUSAL = /^Tool \S+ is not available for this model\./;

/** `[exit code: N]` is appended by `formatExecResult` in execHelpers.ts — a
 *  code-owned string, not a model phrasing. */
const EXIT_CODE = /\[exit code: (\d+|null)\]/g;

export type ActionOutcome = 'ok' | 'failed' | 'unknown';

interface Action {
  outcome: ActionOutcome;
  line: string;
}

/**
 * What a paired tool result says happened.
 *
 * The success case is "a normal result from the registered handler" — every
 * other branch here is a way for a call to have NOT done its work while still
 * producing a `tool` message. Inferring success from the absence of the string
 * `Error:` was the original defect: `User declined:`, the two ToolBudget
 * refusals and the reload marker all sail past it.
 */
export function classifyResult(result: string | undefined): ActionOutcome {
  if (result === undefined) return 'unknown';
  const text = result.trim();
  if (!text) return 'unknown';
  // Not a failure — the call may well have finished — but Forge genuinely does
  // not know, and saying so is the whole point of the `unknown` bucket.
  if (text === TOOL_INTERRUPTED_RESULT) return 'unknown';
  if (isFailureResult(text)) return 'failed';
  if (BUDGET_REFUSAL.test(text) || UNAVAILABLE_REFUSAL.test(text)) return 'failed';
  return 'ok';
}

/** Tool results by the call they answer. `tool_call_id` makes this exact —
 *  pairing positionally would mis-attribute every parallel tool round. */
function resultsByCallId(messages: readonly ChatMessage[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    if (typeof msg.tool_call_id === 'string') byId.set(msg.tool_call_id, msg.content);
  }
  return byId;
}

function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function pathsFrom(args: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) found.push(value.trim().split('\\').join('/'));
  }
  return found;
}

/**
 * Every file path named by a write-tool call.
 *
 * Kept exported and call-derived (not result-derived) because it is the tested
 * primitive and other callers only want "which files were touched". Whether the
 * write SUCCEEDED is `collectWriteActions`' business.
 */
export function collectWrittenFiles(messages: readonly ChatMessage[]): string[] {
  const found = new Set<string>();
  for (const msg of messages) {
    for (const call of msg.tool_calls ?? []) {
      if (!WRITE_TOOLS.has(call.function.name)) continue;
      const args = parseArgs(call.function.arguments);
      if (!args) continue;
      for (const path of pathsFrom(args)) found.add(path);
    }
  }
  return [...found];
}

function writeAction(tool: string, paths: string[], result: string | undefined): Action {
  const target = paths.length > 0 ? paths.join(' → ') : '(unnamed path)';
  const outcome = classifyResult(result);
  if (outcome === 'ok') return { outcome, line: `- ${tool} ${target}` };
  if (outcome === 'unknown') {
    return {
      outcome,
      line: `- ATTEMPTED ${tool} ${target} (no result recorded — outcome unknown)`,
    };
  }
  const why = truncate((result ?? '').trim().split(/\r?\n/, 1)[0] ?? '', 100);
  return { outcome, line: `- FAILED ${tool} ${target} — ${why}` };
}

/** Writes, classified by their paired result rather than by the call alone. */
export function collectWriteActions(messages: readonly ChatMessage[]): Action[] {
  const results = resultsByCallId(messages);
  const actions: Action[] = [];
  for (const msg of messages) {
    for (const call of msg.tool_calls ?? []) {
      if (!WRITE_TOOLS.has(call.function.name)) continue;
      const args = parseArgs(call.function.arguments);
      if (!args) continue;
      actions.push(writeAction(call.function.name, pathsFrom(args), results.get(call.id)));
    }
  }
  return actions;
}

/** A readable command label from the call's own arguments. */
function commandLabel(tool: string, args: Record<string, unknown>): string {
  if (tool === 'exec_command' || tool === 'run_terminal') {
    const command = typeof args['command'] === 'string' ? args['command'] : tool;
    const extra = Array.isArray(args['args'])
      ? args['args'].filter((a): a is string => typeof a === 'string').join(' ')
      : '';
    return truncate(extra ? `${command} ${extra}` : command, 120);
  }
  if (tool === 'run_build') {
    const script = typeof args['script'] === 'string' ? args['script'] : 'build';
    return truncate(`npm run ${script}`, 120);
  }
  if (tool === 'run_tests') {
    const pattern = typeof args['pattern'] === 'string' ? ` ${args['pattern']}` : '';
    return truncate(`run_tests${pattern}`, 120);
  }
  const operation = typeof args['operation'] === 'string' ? ` ${args['operation']}` : '';
  return truncate(`${tool}${operation}`, 120);
}

function lastExitCode(result: string): string | undefined {
  EXIT_CODE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = EXIT_CODE.exec(result)) !== null) last = match[1];
  return last;
}

function commandAction(tool: string, label: string, result: string | undefined): Action {
  const outcome = classifyResult(result);
  if (outcome === 'failed') {
    const why = truncate((result ?? '').trim().split(/\r?\n/, 1)[0] ?? '', 100);
    return { outcome, line: `- ran \`${label}\` → FAILED — ${why}` };
  }
  if (outcome === 'unknown' || result === undefined) {
    return {
      outcome: 'unknown',
      line: `- ran \`${label}\` → outcome unknown (no result recorded)`,
    };
  }
  if (NEVER_COMPLETES.has(tool)) {
    return {
      outcome: 'unknown',
      line: `- pasted \`${label}\` into the terminal → outcome unknown (never runs unattended)`,
    };
  }
  const exit = lastExitCode(result);
  if (exit === undefined) {
    return { outcome: 'unknown', line: `- ran \`${label}\` → outcome unknown (no exit code)` };
  }
  if (exit === 'null') {
    return { outcome: 'unknown', line: `- ran \`${label}\` → did not complete (exit null)` };
  }
  if (exit === '0') return { outcome: 'ok', line: `- ran \`${label}\` → exit 0` };
  return { outcome: 'failed', line: `- ran \`${label}\` → exit ${exit} (FAILED)` };
}

/** Commands, with their exit codes where the host recorded one. */
export function collectCommandActions(messages: readonly ChatMessage[]): Action[] {
  const results = resultsByCallId(messages);
  const actions: Action[] = [];
  for (const msg of messages) {
    for (const call of msg.tool_calls ?? []) {
      if (!COMMAND_TOOLS.has(call.function.name)) continue;
      const args = parseArgs(call.function.arguments) ?? {};
      const label = commandLabel(call.function.name, args);
      actions.push(commandAction(call.function.name, label, results.get(call.id)));
    }
  }
  return actions;
}

/**
 * Apply the per-section cap without letting truncation launder failures.
 *
 * A cap that dropped the tail would turn a section whose failures came last
 * into an all-success list — the ledger would then assert, in Forge's own
 * voice, that work which failed had succeeded. Failed and unknown entries are
 * therefore selected first, and what survives is rendered in original order.
 */
function capActions(actions: readonly Action[]): { lines: string[]; omitted: number } {
  if (actions.length <= RECORDED_ENTRIES_MAX) {
    return { lines: actions.map((a) => a.line), omitted: 0 };
  }
  const kept = new Set<number>();
  for (const [index, action] of actions.entries()) {
    if (action.outcome !== 'ok' && kept.size < RECORDED_ENTRIES_MAX) kept.add(index);
  }
  for (const [index] of actions.entries()) {
    if (kept.size >= RECORDED_ENTRIES_MAX) break;
    kept.add(index);
  }
  return {
    lines: actions.filter((_, index) => kept.has(index)).map((a) => a.line),
    omitted: actions.length - kept.size,
  };
}

function section(title: string, actions: readonly Action[]): string {
  if (actions.length === 0) return '';
  const { lines, omitted } = capActions(actions);
  const more = omitted > 0 ? `\n- …and ${omitted} more` : '';
  return `\n\n**${title} (recorded by Forge, not written by the model):**\n${lines.join('\n')}${more}`;
}

/**
 * The recorded-actions block, or '' when the agent did nothing recordable.
 *
 * No model judgement is involved, so this cannot be forgotten, paraphrased or
 * hallucinated.
 */
export function recordedActionsBlock(messages: readonly ChatMessage[]): string {
  return (
    section('File changes', collectWriteActions(messages)) +
    section('Commands run', collectCommandActions(messages))
  );
}
