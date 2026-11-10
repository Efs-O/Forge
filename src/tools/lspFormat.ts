import * as vscode from 'vscode';
import type { PositionDescription } from './symbolSearch';

export const POSITION_NOTE =
  'Positions are zero-based line:character, the same as the line and character inputs.';

function symbolKindLabel(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] ?? String(kind);
}

/** Format either locations or the location links returned by VS Code providers. */
export function locationToString(loc: vscode.Location | vscode.LocationLink): string {
  const link = loc as vscode.LocationLink;
  const plain = loc as vscode.Location;
  const uri = link.targetUri ?? plain.uri;
  const range = link.targetSelectionRange ?? link.targetRange ?? plain.range;
  if (!uri || !range) return '(location unavailable)';
  return `${vscode.workspace.asRelativePath(uri)}:${range.start.line}:${range.start.character}`;
}

export function formatLocationResults(
  locations: readonly (vscode.Location | vscode.LocationLink)[],
): string {
  return `${locations.map(locationToString).join('\n')}\n\n${POSITION_NOTE}`;
}

export function formatSymbolTree(symbols: vscode.DocumentSymbol[], indent = 0): string[] {
  const lines: string[] = [];
  for (const symbol of symbols) {
    const { line, character } = symbol.selectionRange.start;
    lines.push(
      `${'  '.repeat(indent)}${symbolKindLabel(symbol.kind)} ${symbol.name} (line ${line}, character ${character})`,
    );
    if (symbol.children?.length) {
      lines.push(...formatSymbolTree(symbol.children, indent + 1));
    }
  }
  return lines;
}

export function formatWorkspaceSymbols(symbols: vscode.SymbolInformation[]): string {
  const rows = symbols.map(
    (symbol) =>
      `${symbolKindLabel(symbol.kind)} ${symbol.name} — ${vscode.workspace.asRelativePath(symbol.location.uri)}:${symbol.location.range.start.line}:${symbol.location.range.start.character}`,
  );
  return `${rows.join('\n')}\n\n${POSITION_NOTE}`;
}

/** The answer when a tool position holds no identifier, shared by code_intel and rename_symbol. */
export function noSymbolMessage(
  description: PositionDescription,
  position: vscode.Position,
): string {
  if (position.line >= description.lineCount) {
    return `No symbol at ${description.label}: the file has ${description.lineCount} lines, numbered 0 to ${description.lineCount - 1}.`;
  }
  return `No symbol at ${description.label}. That line reads: \`${description.lineText}\`. Point line and character at the symbol's name. The first line of a file is line 0; document_symbols lists each symbol's zero-based line and character.`;
}
