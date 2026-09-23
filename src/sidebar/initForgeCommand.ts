import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  preferredProjectInstructionsPath,
  resolveInstructionScopeRoot,
} from '../llm/ForgeInstructionsLoader';
import type { SlashCommandDeps } from './SlashCommandHandler';

export async function runInitForgeCommand(deps: SlashCommandDeps): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showWarningMessage(
      'Forge: no workspace folder open — cannot generate FORGE.md.',
    );
    return;
  }
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  const repositoryRoot = resolveInstructionScopeRoot(root, activeFile);
  const instructionsPath = preferredProjectInstructionsPath(repositoryRoot);
  const instructionsName = path.basename(instructionsPath);
  if (fs.existsSync(instructionsPath)) {
    const answer = await vscode.window.showWarningMessage(
      `Forge: ${instructionsName} already exists. Overwrite it?`,
      'Overwrite',
      'Cancel',
    );
    if (answer !== 'Overwrite') return;
  }

  let content: string;
  try {
    content = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Forge: scanning workspace and generating ${instructionsName}…`,
        cancellable: false,
      },
      async () => {
        const context = collectWorkspaceContext(repositoryRoot);
        return deps.runPromptToMarkdown(buildInitForgePrompt(repositoryRoot, context));
      },
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Forge: failed to generate ${instructionsName} — ${(err as Error).message}`,
    );
    return;
  }

  const trimmed = extractMarkdownFromToolCall(content.trim());
  if (!trimmed) {
    void vscode.window.showWarningMessage(
      `Forge: model returned empty content — ${instructionsName} not written.`,
    );
    return;
  }

  try {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(instructionsPath),
      new TextEncoder().encode(trimmed + '\n'),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Forge: could not write ${instructionsName} — ${(err as Error).message}`,
    );
    return;
  }

  void vscode.window.showInformationMessage(
    `Forge: ${instructionsName} created. The agent will use it from the next message.`,
  );
}

function extractMarkdownFromToolCall(raw: string): string {
  // Strip outer markdown code fence if present (```json ... ``` or ``` ... ```)
  const fenceMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)```[\s\S]*$/);
  const inner = fenceMatch ? fenceMatch[1].trim() : raw;
  // Try to parse as a tool call JSON and extract arguments.content
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(inner) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const argContent = (parsed?.arguments as Record<string, any>)?.content;
    if (typeof argContent === 'string' && argContent.trim()) {
      return argContent.trim().replace(/\\n/g, '\n');
    }
  } catch {
    /* not JSON — use as-is */
  }
  return inner;
}

function collectWorkspaceContext(root: string): string {
  const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    '.next',
    '.turbo',
    'coverage',
    '__pycache__',
    '.venv',
    'venv',
  ]);
  const lines: string[] = [];
  // Top-level directory listing
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
      .map((e) => e.name);
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    lines.push(`Top-level dirs: ${dirs.join(', ') || '(none)'}`);
    lines.push(`Top-level files: ${files.join(', ') || '(none)'}`);
  } catch {
    /* unreadable root */
  }
  // package.json — name, scripts keys, dependency names
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const raw = fs.readFileSync(pkgPath, 'utf8').slice(0, 2000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pkg = JSON.parse(raw) as Record<string, any>;
      lines.push(`package name: ${pkg.name ?? '(unnamed)'}`);
      if (pkg.scripts) lines.push(`scripts: ${Object.keys(pkg.scripts as object).join(', ')}`);
      const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
      if (deps.length)
        lines.push(`dependencies: ${deps.slice(0, 30).join(', ')}${deps.length > 30 ? '…' : ''}`);
    } catch {
      /* malformed JSON */
    }
  }
  // Detect common config files that indicate stack
  const indicators = [
    'tsconfig.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
    '.eslintrc',
    'vite.config.ts',
    'webpack.config.js',
  ];
  const found = indicators.filter((f) => fs.existsSync(path.join(root, f)));
  if (found.length) lines.push(`config files present: ${found.join(', ')}`);
  // One level deeper into src/ if it exists
  const srcPath = path.join(root, 'src');
  if (fs.existsSync(srcPath)) {
    try {
      const srcEntries = fs.readdirSync(srcPath, { withFileTypes: true });
      const srcDirs = srcEntries.filter((e) => e.isDirectory()).map((e) => e.name);
      const srcFiles = srcEntries.filter((e) => e.isFile()).map((e) => e.name);
      if (srcDirs.length) lines.push(`src/ subdirs: ${srcDirs.join(', ')}`);
      if (srcFiles.length) lines.push(`src/ files: ${srcFiles.join(', ')}`);
    } catch {
      /* unreadable */
    }
  }
  return lines.join('\n');
}

function buildInitForgePrompt(root: string, context: string): string {
  return `Generate a FORGE.md repository instructions file. All information you need is provided below — do NOT call any tools or request more files.

Workspace root: ${root}

Workspace scan results:
${context}

Write the FORGE.md now. Use only the information above. Output raw markdown only — no preamble, no explanation, no code fences, no tool calls.

Include these sections (skip any where you have no real information):

## Stack
Languages, frameworks, build tools — one or two lines.

## Workspace Layout
Key directories and what they contain (3-8 entries).

## Key Files
3-6 most important files: entry points, config, core modules.

## Navigation Rules
2-4 rules for where things live in this project.

## Hard Stops
1-3 dangerous operations that need explicit user confirmation before running.

Be specific and factual. Do not invent paths or names not present in the scan results above.`;
}
