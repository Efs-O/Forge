/**
 * A Forge-tool tip belongs in the description of the tool it names.
 *
 * Both tips tables (`resources/tips/CODING_TIPS.md`, `docs/CODING_TIPS.md`) may
 * hold a `## FORGE_TOOLS` section, one row per mistake with a Forge tool:
 *
 *     1. `find_files` · `path:"src"` → refused: unknown argument. put the folder in the pattern
 *
 * Those rows leave the big table and are appended to that tool's description
 * instead, because that is the text the model is reading at the moment it builds
 * the call: a row among ~140, thousands of tokens away, loses to the schema in
 * front of it (docs/reports/CODING_TIPS_EFFECTIVENESS_2026_11_18.md). The rows
 * are still written only in the MD file — this module moves them at request time.
 *
 * Leaf module by design: it imports types only, so the pin module can use it
 * without reaching the instruction chain that `codingTips.ts` pulls in.
 */

import type { ToolDefinition } from './types';

/** Rows appended to one tool's description, in file order; the rest stay in the table. */
export const TOOL_TIPS_MAX_PER_TOOL = 20;
/** Bytes of rows appended to one tool's description; the rest stay in the table. */
export const TOOL_TIPS_MAX_BYTES_PER_TOOL = 5000;

/** The section heading both tips files use for Forge-tool rows. */
const SECTION_HEADING = /^##[ \t]+FORGE_TOOLS[ \t]*\r?$/;
/** A numbered tips row, as the tips files write them. */
const NUMBERED_ROW = /^\s*\d+\.\s/;
/** The `1. ` prefix off a row; what is left is the row's body. */
const NUMBER_PREFIX = /^\s*\d+\.\s+/;
/** The `` `tool_name` · tip `` body a row must have to move into a tool. */
const NAMED_ROW = /^`([^`]+)`[ \t]*\u00B7[ \t]*(\S.*)$/;

export interface SplitToolTips {
  /** `text` with every `## FORGE_TOOLS` section removed, plus any overflow rows at the end. */
  table: string;
  /** Bullets to append, keyed by registered tool name, in file order. */
  byTool: Map<string, string[]>;
}

/**
 * Split the Forge-tool rows out of a tips block.
 *
 * A section is its heading line plus the lines after it, up to the first line
 * that is neither blank nor a numbered entry — which covers the next `## `
 * heading too, and that line is kept. A section that runs to the end of the text
 * takes the blank lines before it with it, so no blank run is left behind; a
 * section that stops at a following line leaves them, because they belong there.
 * There may be two sections in one block, one per source: they merge per tool,
 * shipped rows first, because that is file order.
 *
 * A row over a cap, and a row without the `` `name` · `` prefix, stays in the
 * table: renumbered from 1 under one `## FORGE_TOOLS` heading appended at the
 * end, so nothing is lost and the tool says `(N more in the tips table)`.
 */
export function splitToolTips(text: string): SplitToolTips {
  const lines = text.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (n: number): string => lines[n] ?? '';

  const byTool = new Map<string, string[]>();
  /** Bytes of the kept bullets joined, as `Buffer.byteLength(bullets.join('\n'))`. */
  const keptBytes = new Map<string, number>();
  const overflowCounts = new Map<string, number>();
  const overflowRows: string[] = [];
  const removals: Array<[number, number]> = [];

  let i = 0;
  while (i < lines.length) {
    if (!SECTION_HEADING.test(lineAt(i))) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && (lineAt(end).trim() === '' || NUMBERED_ROW.test(lineAt(end)))) {
      end++;
    }
    let from = i;
    // Only a section that runs to the end of the text can leave a blank run
    // behind, so only then do its preceding blank lines go with it. When the
    // section stops at a following line, that blank run belongs to the text.
    if (end === lines.length) {
      while (from > 0 && lineAt(from - 1).trim() === '') from--;
    }
    removals.push([starts[from] ?? 0, starts[end] ?? text.length]);

    for (let row = i + 1; row < end; row++) {
      const body = lineAt(row).replace(NUMBER_PREFIX, '').trim();
      if (!body) continue;
      const named = NAMED_ROW.exec(body);
      if (!named) {
        overflowRows.push(body);
        continue;
      }
      const name = named[1] ?? '';
      const bullet = named[2] ?? '';
      const kept = byTool.get(name) ?? [];
      const bytes = Buffer.byteLength(bullet, 'utf8');
      const candidateBytes = kept.length === 0 ? bytes : (keptBytes.get(name) ?? 0) + 1 + bytes;
      if (kept.length >= TOOL_TIPS_MAX_PER_TOOL || candidateBytes > TOOL_TIPS_MAX_BYTES_PER_TOOL) {
        overflowRows.push(`\`${name}\` \u00B7 ${bullet}`);
        overflowCounts.set(name, (overflowCounts.get(name) ?? 0) + 1);
        continue;
      }
      byTool.set(name, [...kept, bullet]);
      keptBytes.set(name, candidateBytes);
    }
    i = end;
  }

  for (const [name, count] of overflowCounts) {
    byTool.set(name, [...(byTool.get(name) ?? []), `(${count} more in the tips table)`]);
  }

  let table = text;
  for (let r = removals.length - 1; r >= 0; r--) {
    const [from, to] = removals[r] ?? [0, 0];
    table = table.slice(0, from) + table.slice(to);
  }
  if (overflowRows.length > 0) {
    const rows = overflowRows.map((row, n) => `${n + 1}. ${row}`).join('\n');
    const kept = table.replace(/\s+$/, '');
    table = kept === '' ? `## FORGE_TOOLS\n${rows}\n` : `${kept}\n\n## FORGE_TOOLS\n${rows}\n`;
  }
  return { table, byTool };
}

/**
 * Return a new definition list with each tool's tips appended to its description.
 *
 * Never mutates: the registry's definitions are shared between rounds and
 * models, and a description that grew in place would grow again on every round.
 * A tool with no rows comes back as the SAME object, so a request with no tool
 * tips is byte-identical to one before this feature existed.
 */
export function withToolTips(
  defs: ToolDefinition[],
  byTool: ReadonlyMap<string, readonly string[]>,
): ToolDefinition[] {
  return defs.map((def) => {
    const bullets = byTool.get(def.function.name);
    if (!bullets || bullets.length === 0) return def;
    const known = bullets.map((bullet) => `- ${bullet}`).join('\n');
    return {
      ...def,
      function: {
        ...def.function,
        description: `${def.function.description}\n\nKnown mistakes:\n${known}`,
      },
    };
  });
}
