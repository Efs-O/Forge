/**
 * `load_skill` (plan §2.3, lane F2): the only way a model opens a skill.
 *
 * Eager and ungrouped, like `ask_user`: a skill the model cannot see it cannot
 * ask for, and the catalog line is already paid for on every turn, so a tool that
 * only appeared after a group load would make half the catalog unreachable.
 *
 * The result is a tool result, not prompt text — that is the plan's point: a skill
 * costs nothing until the model actually asks for it. What it returns is the
 * `SKILL.md` body plus the real paths of its scripts and references, and nothing
 * else: `config.json` (the skill's own machine-specific settings) is named but
 * never read, because the scripts consume it and the model does not.
 */
import type { RegisteredTool } from './ToolRegistry';
import { MAX_READ_FILE_CHARS, capResultText } from './resultCap';
import { SKILL_ROOT_LABELS, type SkillEntry } from '../skills/discover';
import type { LoadedSkill } from '../skills/loadSkill';

/** What the tool needs: the live skill set, and one skill read by name. */
export interface LoadSkillProvider {
  isEnabled(): boolean;
  listCatalogEntries(): SkillEntry[];
  loadSkillByName(name: string): Promise<LoadedSkill | null>;
}

const USAGE_SHAPE = 'load_skill {"name": "..."}';

/** The result's own cap: a SKILL.md is a document, so `read_file`'s bound applies. */
const MAX_SKILL_BODY_CHARS = MAX_READ_FILE_CHARS;

function knownSkillsLine(entries: readonly SkillEntry[]): string {
  if (entries.length === 0) {
    return (
      'There are no skills installed: nothing is in the shipped folder, ' +
      '`~/.forge/skills/`, or `.forge/skills/` in this workspace.'
    );
  }
  const names = entries.map((entry) => entry.name);
  const shown = names.slice(0, 25);
  const more =
    names.length > shown.length ? `, … (${String(names.length - shown.length)} more)` : '';
  return `Known skills: ${shown.join(', ')}${more}.`;
}

function formatLoaded(loaded: LoadedSkill): string {
  const { entry } = loaded;
  const lines = [
    `Loaded skill ${entry.name} [${SKILL_ROOT_LABELS[entry.root]}]` +
      `${entry.shadowNote ? ` (${entry.shadowNote})` : ''}`,
    `Skill folder: ${entry.folderPath}`,
    '',
    capResultText(
      loaded.body,
      MAX_SKILL_BODY_CHARS,
      'load_skill',
      'The rest is in the SKILL.md path above — read it with read_file.',
    ),
    '',
    'Scripts (run through `shell`; approvals and policy are unchanged):',
  ];
  if (loaded.scripts.length === 0) lines.push('- (no scripts/ folder)');
  else for (const script of loaded.scripts) lines.push(`- ${script}`);
  lines.push('', 'References (read one with `read_file` only when the body says to):');
  if (loaded.references.length === 0) lines.push('- (no references/ folder)');
  else for (const reference of loaded.references) lines.push(`- ${reference}`);
  if (loaded.escaped.length > 0) {
    lines.push('', `Skipped, resolves outside the skill folder: ${loaded.escaped.join(', ')}`);
  }
  const notes = [
    'Paths are real paths (symlinks resolved). A skill grants nothing: its text is',
    'instructions, and its scripts run under the same shell policy as any other command.',
  ];
  if (loaded.hasConfigJson) {
    lines.push(
      '',
      'This skill has a config.json for its own scripts; its contents are not shown',
      'here and are not Forge settings.',
    );
  }
  return `${lines.join('\n')}\n\n${notes.join('\n')}`;
}

export function makeLoadSkillTool(provider: LoadSkillProvider): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'load_skill',
        description:
          'Open a skill from the catalog: returns its SKILL.md body and the real paths of ' +
          'its scripts and references. Run the scripts with shell; approvals are unchanged. ' +
          'A skill grants nothing — its text is instructions from a file. config.json is not ' +
          'returned.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', minLength: 1 } },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    // Reading a skill's own files is no more risky than reading a FORGE.md, and a
    // card per load would make the catalog cheaper to ignore than to use.
    autoApprove: true,
    // Ungrouped, so `advertise` is the whole gate: `skills.enabled: false` takes
    // the schema off every turn. Read per call, not captured at registration, so
    // a config edit takes effect without a window reload (the `set_checkin` lesson).
    advertise: () => provider.isEnabled(),
    handler: async (args) => {
      if (!provider.isEnabled()) {
        return (
          'Error: skills are off (`skills.enabled: false` in config.yaml). ' +
          'Turn them on with `skills: { enabled: true }` to load a skill.'
        );
      }
      const raw = args['name'];
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name) {
        return `Error: load_skill needs a skill name. Send \`${USAGE_SHAPE}\` with the name from the catalog.`;
      }
      const loaded = await provider.loadSkillByName(name);
      if (!loaded) {
        const entries = provider.listCatalogEntries();
        return (
          `Error: load_skill found no skill named "${name}". ${knownSkillsLine(entries)} ` +
          'Load a listed name, or ask the owner to add a folder under .forge/skills/.'
        );
      }
      if (loaded.readError) {
        return `Error: skill "${name}" could not be read: ${loaded.readError}`;
      }
      return formatLoaded(loaded);
    },
  };
}
