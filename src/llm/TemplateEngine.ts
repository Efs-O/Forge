import * as nunjucks from 'nunjucks';
import * as fs from 'fs';
import * as path from 'path';

export interface TemplateContext {
  workspaceName?: string;
  workspaceRoot?: string;
  activeFile?: string;
  selection?: string;
  customInstructions?: string;
  forgeInstructions?: string;
  /** Filled in by `render`; callers do not pass it. */
  currentDate?: string;
}

/**
 * Today, as the local calendar sees it.
 *
 * DATE only, never a time. The system prompt is the KV cache's prefix, so
 * anything in it that ticks re-processes the whole prompt on every turn; a
 * date moves once a day, at an hour nobody is mid-turn.
 */
function today(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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
    const withDate = { currentDate: today(), ...context };
    try {
      return this.env.render(templateName, withDate);
    } catch (err) {
      // Fall back to builtin if user template errors
      const builtinDir = this.templateDirs[this.templateDirs.length - 1];
      const builtinPath = path.join(builtinDir, templateName);
      if (fs.existsSync(builtinPath)) {
        const raw = fs.readFileSync(builtinPath, 'utf8');
        return nunjucks.renderString(raw, withDate);
      }
      throw err;
    }
  }

  /** Reload by creating a new environment (called on file save). */
  reload(userDirs: string[]): void {
    this.templateDirs = [...userDirs, this.templateDirs[this.templateDirs.length - 1]];
    const loader = new nunjucks.FileSystemLoader(this.templateDirs, { noCache: true });
    this.env = new nunjucks.Environment(loader, { autoescape: false, throwOnUndefined: false });
  }
}
