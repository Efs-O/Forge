import * as nunjucks from 'nunjucks';
import { localDate } from '../util/localClock';

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
  /** Filled in by `render`; callers do not pass it. */
  currentDate?: string;
}

export class TemplateEngine {
  private env: nunjucks.Environment;
  private templateDirs: string[];

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
    // Injected here rather than at each call site: a model with no clock has
    // no way to date anything it writes, and asking for one cost a round to a
    // banned `powershell -Command "Get-Date"` and a fallback to `node -e`.
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
}
