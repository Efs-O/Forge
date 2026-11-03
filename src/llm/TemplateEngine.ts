import * as nunjucks from 'nunjucks';
import { localDate } from '../util/localClock';
import type { ConversationRuntime } from '../sidebar/sessionTypes';

/**
 * Who can say what skills catalog a conversation should be shown.
 *
 * A getter rather than a string, because the answer is per conversation and per
 * activation: `src/skills/skillsService.ts` freezes one catalog for the life of a
 * chat, and `undefined` (a one-shot prompt run) means build fresh.
 */
export type SkillsCatalogGetter = (
  conversation: ConversationRuntime | undefined,
) => string | undefined;

export interface TemplateContext {
  workspaceName?: string;
  workspaceRoot?: string;
  /** Set when the root holds `.git` or `package.json`, i.e. no nested project. */
  workspaceIsProjectRoot?: string;
  activeFile?: string;
  selection?: string;
  customInstructions?: string;
  forgeInstructions?: string;
  /** Set when web_search or web_fetch is in the request's tools. */
  webTools?: string;
  /** Set when `ask_agent` or `ask_local_agent` is in the request's tools, so the
   *  delegation rules reach only a workspace that has someone to delegate to. */
  agentTools?: string;
  /**
   * The skills catalog for this conversation, rendered once and frozen for its
   * life (`src/skills/skillsService.ts`). Absent means no block: a user with no
   * skills, or skills off, keeps the prompt they always had.
   */
  skillsCatalog?: string;
  /** Filled in by `render`; callers do not pass it. */
  currentDate?: string;
}
export class TemplateEngine {
  private env: nunjucks.Environment;
  private templateDirs: string[];
  private skillsCatalogGetter: SkillsCatalogGetter | undefined;

  constructor(builtinDir: string, userDirs: string[] = []) {
    this.templateDirs = [...userDirs, builtinDir];
    const loader = new nunjucks.FileSystemLoader(this.templateDirs, { noCache: false });
    this.env = new nunjucks.Environment(loader, {
      autoescape: false, // system prompts are trusted content
      throwOnUndefined: false,
    });
    // No custom globals or filters that could execute arbitrary code
  }

  /**
   * Render a named prompt template.
   * Looks for `<name>.njk` in user dirs first, then builtin dir.
   */
  render(name: string, context: TemplateContext): string {
    const templateName = `${name}.njk`;
    // Injected for user templates under .forge/templates/ that reference it.
    // The builtin no longer does: the model gets the date in the per-turn
    // context (turnContext.ts), because a date in the system prompt rolls over
    // at midnight and forces a full re-read of the whole conversation.
    const withDate = { currentDate: localDate(), ...context };
    // A user template that fails to render throws: falling back to the builtin
    // would run the turn on a prompt the user did not write, with no sign of it.
    return this.env.render(templateName, withDate);
  }

  /** Reload by creating a new environment (called on file save). */
  reload(userDirs: string[]): void {
    this.templateDirs = [...userDirs, this.templateDirs[this.templateDirs.length - 1]];
    const loader = new nunjucks.FileSystemLoader(this.templateDirs, { noCache: true });
    this.env = new nunjucks.Environment(loader, { autoescape: false, throwOnUndefined: false });
  }

  /**
   * The object that says which skills catalog each conversation should render.
   *
   * Set once by `extension.ts` after the skills service exists. It hangs here
   * rather than being threaded as a new argument through `SidebarProvider`,
   * `sidebarWiring`, `AgentLoop`, `turnServices` and `ModelTurn`, because this is
   * the one object that already reaches every path that renders a system prompt
   * (`ModelTurn` and `PromptRun` both take it), and those four files sit at the
   * 500-line gate this repo lints — threading one string through them would have
   * cost three file splits for no behaviour change. The engine still renders no
   * catalog by itself: callers pass the string into `render` as `skillsCatalog`.
   */
  setSkillsCatalogProvider(getter: SkillsCatalogGetter | undefined): void {
    this.skillsCatalogGetter = getter;
  }

  /** The catalog for `conversation`, or undefined when skills are off or none. */
  skillsCatalogFor(conversation?: ConversationRuntime): string | undefined {
    return this.skillsCatalogGetter?.(conversation);
  }
}
