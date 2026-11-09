/**
 * A path argument that ends in whitespace is a stray space, not a filename.
 *
 * Windows cannot even store one — `scratch ` and `scratch` are the same name — yet a
 * model that writes `path: "…/scratch "` loses a whole round: both `read_file` and
 * `list_directory` answered *"nothing exists there"* about a folder that exists (lab arm
 * U6b, 2026-11-09, reproduced by the teacher's own `read_file` call). The refusal then
 * blames the workspace root and points at `find_files`, so the round is spent chasing a
 * base that was never wrong.
 *
 * The repair happens once, in `ToolDispatch`, **before** the approval metadata, the
 * mutation paths and the checkpoint snapshot read the arguments — a gate that judges
 * `"foo.ts "` while the tool writes `"foo.ts"` would protect one path and edit another.
 * Only *trailing* spaces and tabs are removed; a path that begins with a space, or
 * contains one, is passed through exactly as the model wrote it.
 *
 * Which arguments count is decided from the tool's own schema, not from a guess: a
 * declared string (or string array) whose name is one of the unambiguous path names, or
 * whose description speaks of a path, a directory or a folder. That is what keeps
 * `edit_notebook_cell`'s `source` — cell text, where trailing whitespace is meaningful —
 * out of the repair while `move_file`'s `source`, which the schema calls a path, stays in.
 * On POSIX a trailing space is a legal character, so the repair is never silent:
 * `trailingPathSpaceNote` names the arguments it repaired.
 */

/** Names that are always a path the tool will open, whatever the description says. */
const ALWAYS_PATH = new Set(['path', 'paths', 'cwd', 'destination']);
/** Names that are never a path, whatever the description says. */
const NEVER_PATH = new Set(['to', 'from', 'query', 'code', 'language']);
/** A description that says "this is a path" in the words the schemas already use. */
const PATH_IN_DESCRIPTION = /\bpaths?\b|\bdirectory\b|\bfolder\b/iu;

interface DeclaredArgument {
  type?: unknown;
  description?: unknown;
  items?: { type?: unknown };
}

function isPathArgument(name: string, schema: DeclaredArgument): boolean {
  if (NEVER_PATH.has(name)) return false;
  if (ALWAYS_PATH.has(name)) return true;
  return typeof schema.description === 'string' && PATH_IN_DESCRIPTION.test(schema.description);
}

/** Strip trailing spaces/tabs from one value; returns it only when it changed. */
function trimmed(value: string): string | undefined {
  const next = value.replace(/[ \t]+$/u, '');
  return next === value || next === '' ? undefined : next;
}

/**
 * Repair the path arguments of `args` in place, so every later reader — the approval
 * metadata, `mutation.paths`, the checkpoint snapshot and the handler — sees one path.
 * Returns the argument names it repaired, in the order it found them.
 */
export function repairTrailingPathSpace(
  parameters: unknown,
  args: Record<string, unknown>,
): string[] {
  const properties = (parameters as { properties?: unknown } | null)?.properties;
  if (typeof properties !== 'object' || properties === null) return [];
  const repaired: string[] = [];
  for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const schema = raw as DeclaredArgument;
    if (!isPathArgument(name, schema)) continue;
    const value = args[name];
    if (schema.type === 'string' && typeof value === 'string') {
      const next = trimmed(value);
      if (next === undefined) continue;
      args[name] = next;
      repaired.push(name);
      continue;
    }
    const listEntryIsPath =
      schema.type === 'array' &&
      (schema.items?.type === undefined || schema.items.type === 'string');
    if (!listEntryIsPath || !Array.isArray(value)) continue;
    let changed = false;
    const next = value.map((entry) => {
      if (typeof entry !== 'string') return entry;
      const entryTrimmed = trimmed(entry);
      if (entryTrimmed === undefined) return entry;
      changed = true;
      return entryTrimmed;
    });
    if (!changed) continue;
    args[name] = next;
    repaired.push(name);
  }
  return repaired;
}

/** The line appended to the tool result so the repair is never silent. */
export function trailingPathSpaceNote(repaired: string[]): string | undefined {
  if (repaired.length === 0) return undefined;
  const list =
    repaired.length === 1 ? `argument "${repaired[0]}"` : `arguments "${repaired.join('", "')}"`;
  return `Note: ${list} ended with a space; trimmed ${repaired.length === 1 ? 'it' : 'them'} before running the tool.`;
}
