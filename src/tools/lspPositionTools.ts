/**
 * The four `code_intel` operations that answer about a position: hover,
 * definition, references, implementations. Each one is the same shape — resolve
 * the path, make sure the language service has actually parsed the file,
 * describe the word at `line`:`character`, bail with `noSymbolMessage` when
 * there is no word there, then ask exactly one provider about it.
 *
 * Split out of `lspTools.ts` on 2026-11-24
 * (`docs/plans/LSP_TOOLS_SPLIT_PLAN.md`, Seam 2). The hover loading retry and
 * the references text-search gap note live here with the one handler each of
 * them prints, so the whole behaviour is read next to the answer it hedges.
 */
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { sleepOrThrow } from '../util/abortableSleep';
import { describePosition, primeSymbolAtPosition } from './symbolSearch';
import { formatLocationResults, noSymbolMessage } from './lspFormat';
import { openForAnalysis } from './lspTools';

function noProviderAnswer(
  kind: 'references' | 'definition' | 'implementations' | 'hover information',
  description: Awaited<ReturnType<typeof describePosition>>,
): string {
  return `No ${kind} found for \`${description.word}\` at ${description.label}. That line reads: \`${description.lineText}\`. If \`${description.word}\` is not the symbol you meant (for example a word in a comment or a string), point line and character at the symbol's name.`;
}

function missingTextSearchFiles(
  result: readonly (vscode.Location | vscode.LocationLink)[] | undefined,
  searched: readonly string[],
): string[] {
  const reported = new Set(
    (result ?? []).map((location) => {
      const link = location as vscode.LocationLink;
      const plain = location as vscode.Location;
      return pathKey(vscode.workspace.asRelativePath(link.targetUri ?? plain.uri));
    }),
  );
  return searched
    .map((file) => vscode.workspace.asRelativePath(vscode.Uri.file(file)).replace(/\\/gu, '/'))
    .filter((file) => !reported.has(pathKey(file)))
    .sort();
}

function pathKey(value: string): string {
  return value.replace(/\\/gu, '/').toLowerCase();
}

function referencesTextNote(name: string, missing: readonly string[]): string {
  return missing.length
    ? `\n\nNote: a text search also finds \`${name}\` in ${missing.length} file(s) the language server did not report: ${missing.join(', ')}. The language server may still be loading this project; ask again in a few seconds, or check those files with grep_search.`
    : '';
}

const HOVER_LOADING_NOTE =
  '\n\nNote: `(loading...)` means the language server has not finished loading this project, so this answer may lack types. Ask again in a few seconds.';

function hoverText(result: vscode.Hover[] | undefined): string {
  if (!result?.length) return '';
  const parts: string[] = [];
  for (const hover of result) {
    for (const content of hover.contents) {
      if (typeof content === 'string') parts.push(content);
      else if ('value' in content) parts.push(content.value);
    }
  }
  return parts.join('\n\n');
}

async function hoverWithLoadingRetry(
  uri: vscode.Uri,
  position: vscode.Position,
  signal?: AbortSignal,
): Promise<string> {
  const ask = async (): Promise<string> =>
    hoverText(
      await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
        'vscode.executeHoverProvider',
        uri,
        position,
      ),
    );
  let answer = await ask();
  for (const delay of [250, 500, 1000, 2000, 4000]) {
    if (!answer.includes('(loading...)')) return answer;
    // `sleepOrThrow` rejects on abort, so Stop ends the retry loop instead of
    // leaving up to 7.75 s of loading retries running after the turn is over.
    await sleepOrThrow(delay, signal, () => new Error('hover retry aborted by Stop'));
    answer = await ask();
  }
  return answer.includes('(loading...)') ? `${answer}${HOVER_LOADING_NOTE}` : answer;
}

// ── Hover handler ──────────────────────────────────────────────────────────────

export function makeGetHoverTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: '__code_intel_get_hover',
        description: 'Get hover information (type info, docs) at a specific position in a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            line: { type: 'integer', description: 'Zero-based line number.' },
            character: { type: 'integer', description: 'Zero-based character offset.' },
          },
          required: ['path', 'line', 'character'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args, context) => {
      const displayPath = args['path'] as string;
      const uri = await openForAnalysis(displayPath);
      const position = new vscode.Position(args['line'] as number, args['character'] as number);
      const description = await describePosition(uri, position, displayPath);
      if (!description.word) return noSymbolMessage(description, position);
      const answer = await hoverWithLoadingRetry(uri, position, context?.abortSignal);
      return answer || noProviderAnswer('hover information', description);
    },
  };
}

// ── Definition handler ─────────────────────────────────────────────────────────

export function makeGoToDefinitionTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: '__code_intel_go_to_definition',
        description: 'Find the definition location(s) of the symbol at the given position.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            line: { type: 'integer', description: 'Zero-based line number.' },
            character: { type: 'integer', description: 'Zero-based character offset.' },
          },
          required: ['path', 'line', 'character'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const displayPath = args['path'] as string;
      const uri = await openForAnalysis(displayPath);
      const position = new vscode.Position(args['line'] as number, args['character'] as number);
      const description = await describePosition(uri, position, displayPath);
      if (!description.word) return noSymbolMessage(description, position);
      await primeSymbolAtPosition(uri, position);
      const result = await vscode.commands.executeCommand<
        Array<vscode.Location | vscode.LocationLink> | undefined
      >('vscode.executeDefinitionProvider', uri, position);
      if (!result?.length) return noProviderAnswer('definition', description);
      return formatLocationResults(result);
    },
  };
}

// ── References handler ─────────────────────────────────────────────────────────

export function makeFindReferencesTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: '__code_intel_find_references',
        description: 'Find all references to the symbol at the given position (max 50).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            line: { type: 'integer', description: 'Zero-based line number.' },
            character: { type: 'integer', description: 'Zero-based character offset.' },
          },
          required: ['path', 'line', 'character'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const displayPath = args['path'] as string;
      const uri = await openForAnalysis(displayPath);
      const position = new vscode.Position(args['line'] as number, args['character'] as number);
      const description = await describePosition(uri, position, displayPath);
      if (!description.word) return noSymbolMessage(description, position);
      const primed = await primeSymbolAtPosition(uri, position);
      const result = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
        'vscode.executeReferenceProvider',
        uri,
        position,
      );
      const answer = result?.length
        ? formatLocationResults(result.slice(0, 50))
        : noProviderAnswer('references', description);
      return (
        answer + referencesTextNote(primed.name ?? '', missingTextSearchFiles(result, primed.files))
      );
    },
  };
}

// ── Implementations handler ────────────────────────────────────────────────────

/**
 * "Who implements this?" — the question the `references` operation answers badly.
 *
 * On an interface or abstract method, references returns every call site mixed
 * in with the implementations, and the implementations are usually the few
 * rows the reader wanted. The implementation provider returns only those.
 *
 * Like the definition provider, this one may answer with LocationLink[] rather
 * than the Location[] its type claims, so it goes through formatLocationResults.
 */
export function makeFindImplementationsTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: '__code_intel_find_implementations',
        description:
          'Find the implementations of the interface, abstract class, or abstract method at the ' +
          'given position (max 50). Prefer this over the references operation when you want the ' +
          'concrete types implementing something rather than every call site.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            line: { type: 'integer', description: 'Zero-based line number.' },
            character: { type: 'integer', description: 'Zero-based character offset.' },
          },
          required: ['path', 'line', 'character'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const displayPath = args['path'] as string;
      const uri = await openForAnalysis(displayPath);
      const position = new vscode.Position(args['line'] as number, args['character'] as number);
      const description = await describePosition(uri, position, displayPath);
      if (!description.word) return noSymbolMessage(description, position);
      await primeSymbolAtPosition(uri, position);
      const result = await vscode.commands.executeCommand<
        Array<vscode.Location | vscode.LocationLink> | undefined
      >('vscode.executeImplementationProvider', uri, position);
      if (!result?.length) return noProviderAnswer('implementations', description);
      return formatLocationResults(result.slice(0, 50));
    },
  };
}
