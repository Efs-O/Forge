import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { markdownToDocx } from '../documents/docxFromMarkdown';
import { localMarkdownImageResolver, markdownToHtml } from '../documents/markdownToHtml';
import { printHtmlToPdf } from '../documents/pdfExport';
import { resolveRealWorkspacePath, resolveWorkspacePath } from '../util/WorkspacePaths';
import { agentWriteOptions, writeFileAtomic } from '../util/atomicWrite';
import { secretPatternForTaint } from './secretPaths';
import type { RegisteredTool } from './ToolRegistry';
import { unattendedConversations } from '../sidebar/unattendedConversations';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export interface ExportDocumentDeps {
  getConfig?: () => ForgeConfig;
  extraRoots?: () => readonly string[];
  printPdf?: typeof printHtmlToPdf;
  clankerMode?: (conversationId: string) => boolean;
}

export function makeExportDocumentTool(deps: ExportDocumentDeps = {}): RegisteredTool {
  const outputPath = (args: Record<string, unknown>): string[] =>
    typeof args['output'] === 'string' ? [args['output']] : [];
  const secretOutput = (raw: string): string | undefined =>
    secretPatternForTaint(raw, deps.getConfig?.(), (value) => {
      try {
        return resolveWorkspacePath(value);
      } catch {
        return undefined;
      }
    });

  return {
    definition: {
      type: 'function',
      function: {
        name: 'export_document',
        description:
          'Export a workspace Markdown or HTML source file to PDF or DOCX. ' +
          'The source is a path, never a text blob. PDF prints through headless Chrome; DOCX preserves headings, lists, tables and local images. The output is checkpointed and can be undone.',
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Workspace path to a .md, .markdown, or .html file.',
            },
            format: { type: 'string', enum: ['pdf', 'docx'], description: 'Output format.' },
            output: {
              type: 'string',
              description: 'Workspace path for the new .pdf or .docx file.',
            },
          },
          required: ['source', 'format', 'output'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: outputPath },
    approval: (args, approvalContext) => {
      const source = typeof args['source'] === 'string' ? args['source'] : undefined;
      const conversationId = approvalContext?.conversationId;
      if (!source || !conversationId || unattendedConversations.has(conversationId))
        return undefined;
      const output = typeof args['output'] === 'string' ? args['output'] : undefined;
      const outputSecret = output ? secretOutput(output) : undefined;
      const sourceSecret = secretPatternForTaint(source, deps.getConfig?.(), (value) => {
        try {
          return resolveWorkspacePath(value);
        } catch {
          return undefined;
        }
      });
      if (deps.clankerMode?.(conversationId) !== true || (!sourceSecret && !outputSecret))
        return undefined;
      return {
        ...(outputSecret ? { dangerous: true } : {}),
        detail: outputSecret
          ? `Write export output ${output} to secret path ${outputSecret}.`
          : `Read secret source ${source} into a local document export.`,
      };
    },
    refuseBeforeApproval: (args, context) => {
      const raw = typeof args['output'] === 'string' ? args['output'] : undefined;
      const match = raw ? secretOutput(raw) : undefined;
      if (match && context?.clankerMode === true) return undefined;
      return match
        ? `Error: export_document: output matches secret path rule ${match}; choose a non-secret path.`
        : undefined;
    },
    handler: async (args, context) => {
      const source = args['source'];
      const format = args['format'];
      const output = args['output'];
      if (typeof source !== 'string' || typeof output !== 'string')
        throw new Error('export_document: source and output must be workspace paths.');
      if (format !== 'pdf' && format !== 'docx')
        throw new Error('export_document: format must be "pdf" or "docx".');
      if (format === 'docx' && path.extname(source).toLowerCase() === '.html')
        throw new Error(
          'export_document: HTML sources can be exported to PDF; use a Markdown source for DOCX.',
        );
      const secret = secretOutput(output);
      if (secret && context?.clankerMode !== true)
        throw new Error(
          `export_document: output matches secret path rule ${secret}; choose a non-secret path.`,
        );
      const roots = deps.extraRoots?.() ?? [];
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) throw new Error('export_document: no workspace folder is open.');
      const sourcePath = await resolveRealWorkspacePath(source, workspaceRoot, {
        extraRoots: roots,
      });
      const sourceSecret = secretPatternForTaint(source, deps.getConfig?.(), (value) => {
        try {
          return resolveWorkspacePath(value, { workspaceRoot });
        } catch {
          return undefined;
        }
      });
      if (sourceSecret && context?.clankerMode !== true)
        throw new Error(
          `export_document: source matches secret path rule ${sourceSecret}; choose a non-secret document.`,
        );
      const sourceExtension = path.extname(sourcePath).toLowerCase();
      if (!['.md', '.markdown', '.html'].includes(sourceExtension))
        throw new Error('export_document: source must be .md, .markdown, or .html.');
      const sourceBytes = fs.readFileSync(sourcePath);
      if (sourceBytes.length > MAX_SOURCE_BYTES)
        throw new Error('export_document: source exceeds the 2 MiB limit.');
      const sourceText = sourceBytes.toString('utf8');
      const target = await resolveRealWorkspacePath(output, workspaceRoot, {
        allowMissing: true,
        extraRoots: roots,
      });
      const targetExtension = path.extname(target).toLowerCase();
      if (targetExtension !== `.${format}`)
        throw new Error(`export_document: output extension must be .${format}.`);
      if (context?.abortSignal?.aborted)
        throw new Error('export_document: cancelled before export.');
      const omittedImages: string[] = [];
      const markdownHtmlOptions = {
        resolveImage: localMarkdownImageResolver(sourcePath, workspaceRoot, roots, deps.getConfig),
        // Keep inline images well below printHtmlToPdf's 2 MiB HTML cap even
        // when the Markdown source itself is near its 2 MiB limit.
        maxImageDataUriBytes: 512 * 1024,
        omittedImages,
      };
      const bytes =
        format === 'pdf'
          ? await (deps.printPdf ?? printHtmlToPdf)(
              sourceExtension === '.html'
                ? sourceText
                : await markdownToHtml(sourceText, markdownHtmlOptions),
              deps.getConfig,
              context?.abortSignal,
            )
          : await markdownToDocx(sourceText, sourcePath, workspaceRoot, roots, deps.getConfig, {
              omittedImages,
            });
      if (context?.abortSignal?.aborted)
        throw new Error('export_document: cancelled before writing.');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await writeFileAtomic(target, bytes, agentWriteOptions(context?.abortSignal));
      const omitted =
        omittedImages.length === 0
          ? ''
          : format === 'pdf'
            ? ` Images omitted because they were too large for PDF export: ${omittedImages.join(', ')}.`
            : ` Images the DOCX export did not embed (missing, outside the roots it may read, or over its image budget): ${omittedImages.join(', ')}.`;
      return `Exported ${source} to ${output} (${format.toUpperCase()}, ${bytes.length.toLocaleString()} bytes).${omitted}`;
    },
  };
}
