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
    try {
      return this.env.render(templateName, context);
    } catch (err) {
      // Fall back to builtin if user template errors
      const builtinDir = this.templateDirs[this.templateDirs.length - 1];
      const builtinPath = path.join(builtinDir, templateName);
      if (fs.existsSync(builtinPath)) {
        const raw = fs.readFileSync(builtinPath, 'utf8');
        return nunjucks.renderString(raw, context);
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
