/**
 * The shared machinery for checking the YAML an article shows against the
 * config schema. `AiSetupDoc.test.ts` used to check only the top-level key
 * names, which is how four README examples kept a `models:` **map** shape for
 * months while the schema wanted an array: every key was legal, only the shape
 * was not. This parses the blocks.
 *
 * A block is a complete example unless it carries `# partial:` — the marker a
 * reader needs anyway, because a fragment copied into a fresh `config.yaml`
 * fails validation for reasons the fragment itself cannot show (no models, no
 * `active_model`). A partial block is checked key by key against that key's own
 * schema, so a wrong shape inside a fragment still fails.
 */
import { parse } from 'yaml';
import { ForgeConfigSchema } from '../../src/config/schema';

export const PARTIAL_MARKER = '# partial:';

export interface YamlBlock {
  /** 1-based line of the opening fence. */
  fenceLine: number;
  /** The block with the fence's own indentation removed. */
  content: string;
}

const indentOf = (line: string): number => line.length - line.replace(/^\s+/, '').length;

/** Every fenced ```yaml / ```yml block, including the indented ones that sit inside list items. */
export function yamlBlocks(markdown: string): YamlBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: YamlBlock[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^\s*```(?:yaml|yml)\s*$/.exec(lines[i] ?? '');
    if (!open) continue;
    const fenceIndent = indentOf(lines[i]!);
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j] ?? '';
      if (line.trim() === '```' && indentOf(line) >= fenceIndent) break;
      body.push(line.slice(fenceIndent));
    }
    blocks.push({ fenceLine: i + 1, content: body.join('\n') });
    i = j;
  }
  return blocks;
}

const issueText = (error: { issues: { path: (string | number)[]; message: string }[] }): string =>
  error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join(' · ');

/** Errors for one block; empty means the example is valid as written. */
export function validateConfigExample(content: string): string[] {
  let value: unknown;
  try {
    value = parse(content);
  } catch (error) {
    return [`yaml does not parse: ${(error as Error).message.split('\n')[0]}`];
  }
  if (value === null || value === undefined) return ['the block is empty'];
  if (content.includes(PARTIAL_MARKER)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return ['a partial example must show a mapping of config keys'];
    }
    const errors: string[] = [];
    for (const [key, sectionValue] of Object.entries(value as Record<string, unknown>)) {
      const section = ForgeConfigSchema.shape[key as keyof typeof ForgeConfigSchema.shape];
      if (section === undefined) {
        errors.push(`the schema has no top-level key \`${key}\``);
        continue;
      }
      const result = (
        section as {
          safeParse(value: unknown): {
            success: boolean;
            error?: { issues: { path: (string | number)[]; message: string }[] };
          };
        }
      ).safeParse(sectionValue);
      if (!result.success) errors.push(`${key}: ${issueText(result.error!)}`);
    }
    return errors;
  }
  const whole = ForgeConfigSchema.safeParse(value);
  return whole.success ? [] : [issueText(whole.error!)];
}

/** Every `# ` line that marks a block partial, so a test can name the marker it wants. */
export function isPartialExample(content: string): boolean {
  return content.includes(PARTIAL_MARKER);
}
