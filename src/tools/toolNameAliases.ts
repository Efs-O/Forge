/**
 * Names from the coding agents a model was trained on, answered by the tool that
 * does the job here.
 *
 * The tool layer grew its names by inherited default (no commit in this repo
 * records a naming decision), so a model that reaches for `grep_search`, `bash`
 * or `create_file` is not confused — it is speaking another dialect. Answering
 * the dialect once, in code, is cheaper than teaching every model the same
 * lesson again in prompt text: the audit behind the streamline plan counted
 * seven chats where a model typed a foreign name and got `unknown tool`.
 *
 * Matching is EXACT and case-sensitive. There is no fuzzy matching on purpose:
 * `edit_file` deliberately does not accept `apply_patch`, because the same verb
 * with a different argument shape would take the call and then fail on the
 * payload, which reads worse than a refusal that names the tool.
 *
 * Aliases are never advertised, so they cost zero prompt tokens. Every hit is
 * counted in a file the next session can read, so the next expansion is a
 * decision from data — and a name that never fires is evidence that models did
 * not know it after all.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolCall } from '../llm/types';

/** Alias name → the tool that answers it. Exact match, one target per name. */
export const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  // Codex CLI and Cursor dialects.
  bash: 'shell',
  create_file: 'write_file',
  codebase_search: 'search_codebase',
  file_search: 'find_files',
  glob: 'find_files',
  ls: 'list_directory',
  // Claude Code's background-output reader.
  BashOutput: 'monitor_execution',
  // The name this tool had until 2026-11-14. Kept so saved sessions, other
  // agents and models trained on the old dialect keep working after the rename.
  search_code: 'grep_search',
};

export type ToolNameAliasHit = { readonly alias: string; readonly tool: string };

/** The canonical name for a foreign name, or undefined when it is not an alias. */
export function canonicalToolName(name: string): string | undefined {
  return Object.hasOwn(TOOL_NAME_ALIASES, name) ? TOOL_NAME_ALIASES[name] : undefined;
}

/**
 * Rewrite one tool call's name in place, before any gate sees it, so approval,
 * the budget, the handler and the result message all judge the real tool.
 * Returns what it changed, or undefined when the name was already canonical.
 */
export function applyToolNameAlias(call: ToolCall): ToolNameAliasHit | undefined {
  const tool = canonicalToolName(call.function.name);
  if (!tool) return undefined;
  const alias = call.function.name;
  call.function.name = tool;
  return { alias, tool };
}

/**
 * Where hits accumulate. One JSON line per call, so a partial write costs one
 * row. `FORGE_TOOL_ALIAS_FILE` redirects it — the tests use that so a suite run
 * does not inflate the counts the report reads.
 */
export function aliasUsageFile(): string {
  const override = process.env.FORGE_TOOL_ALIAS_FILE;
  if (override) return override;
  return path.join(os.homedir(), '.forge', 'telemetry', 'tool-aliases.jsonl');
}

/**
 * Append one hit. Never throws: a model's call must not fail because the
 * counter could not be written, and the counter is not worth retrying.
 */
export function recordToolNameAliasHit(
  hit: ToolNameAliasHit,
  convId?: string,
  file = aliasUsageFile(),
): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({ ts: new Date().toISOString(), alias: hit.alias, tool: hit.tool, ...(convId ? { conv: convId.slice(0, 8) } : {}) })}\n`,
      'utf8',
    );
  } catch {
    // The call already ran; a lost count is not worth a refusal or a retry.
  }
}

/** Per-alias counts from the usage file, for the report the plan asks for. */
export function readAliasUsage(file = aliasUsageFile()): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { alias?: unknown };
      if (typeof row.alias === 'string') out[row.alias] = (out[row.alias] ?? 0) + 1;
    } catch {
      // A half-written last line is expected after a crash; skip it and keep counting.
    }
  }
  return out;
}
