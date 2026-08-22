import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REGISTRY_SOURCE_FILE = 'src/tools/registerAllTools.ts';

export function extractToolDefinitions() {
  const registryPath = path.join(ROOT, REGISTRY_SOURCE_FILE);
  const registrySource = ts.createSourceFile(
    registryPath,
    fs.readFileSync(registryPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const constructorSources = new Map();
  for (const statement of registrySource.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const clause = statement.importClause?.namedBindings;
    if (!clause || !ts.isNamedImports(clause)) continue;
    const source = `${path.posix.join('src/tools', statement.moduleSpecifier.text)}.ts`;
    for (const element of clause.elements) constructorSources.set(element.name.text, source);
  }

  const registrations = [];
  visit(registrySource, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (node.expression.expression.getText(registrySource) !== 'registry') return;
    if (node.expression.name.text !== 'register') return;
    const factoryCall = node.arguments[0];
    if (
      !factoryCall ||
      !ts.isCallExpression(factoryCall) ||
      !ts.isIdentifier(factoryCall.expression)
    )
      return;
    registrations.push(factoryCall.expression.text);
  });

  const definitions = [];
  for (const constructorName of registrations) {
    const relativePath = constructorSources.get(constructorName);
    if (!relativePath)
      throw new Error(`Cannot resolve registered tool constructor ${constructorName}`);
    const filename = path.join(ROOT, relativePath);
    const sourceFile = ts.createSourceFile(
      filename,
      fs.readFileSync(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    visit(sourceFile, (node) => {
      if (!ts.isPropertyAssignment(node) || propertyName(node.name) !== 'definition') return;
      const value = expressionToValue(node.initializer);
      if (!isToolDefinition(value)) return;
      const owner = ts.isObjectLiteralExpression(node.parent) ? node.parent : undefined;
      const permissionNode = owner?.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) && propertyName(property.name) === 'permission',
      );
      definitions.push({
        ...value,
        source: relativePath,
        origin: 'native',
        factory: findFactoryName(node),
        permission:
          permissionNode && ts.isPropertyAssignment(permissionNode)
            ? expressionToValue(permissionNode.initializer)
            : 'unknown',
      });
    });
  }

  const seen = new Set();
  const unique = definitions.filter((definition) => {
    const name = definition.function.name;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  if (unique.length !== registrations.length) {
    throw new Error(
      `Canonical registry has ${registrations.length} registrations but ${unique.length} definitions were extracted`,
    );
  }
  return unique;
}

function findFactoryName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    current = current.parent;
  }
  return 'unknown';
}

export async function discoverMcpDefinitions(configPath, nativeNames) {
  const document = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const servers = Array.isArray(document?.mcp_servers) ? document.mcp_servers : [];
  const definitions = [];
  const clients = [];
  try {
    for (const server of servers) {
      if (!server || typeof server.name !== 'string' || typeof server.command !== 'string') {
        throw new Error('Invalid MCP server config: name and command are required');
      }
      const transport = new StdioClientTransport(
        Array.isArray(server.args)
          ? { command: server.command, args: server.args, stderr: 'pipe' }
          : { command: server.command, stderr: 'pipe' },
      );
      transport.stderr?.on('data', () => undefined);
      const client = new Client({ name: 'forge-tool-audit', version: '1.0.0' });
      await client.connect(transport);
      clients.push(client);
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        if (
          nativeNames.has(tool.name) ||
          definitions.some((item) => item.function.name === tool.name)
        ) {
          console.warn(`MCP ${server.name}: skipping duplicate tool name ${tool.name}`);
          continue;
        }
        definitions.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description ?? '',
            parameters: tool.inputSchema ?? {},
          },
          source: `mcp:${server.name}`,
          origin: 'mcp',
          factory: 'mcpToolToRegisteredTool',
          permission: server.tool_permissions?.[tool.name] ?? 'read',
        });
      }
    }
    return definitions;
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }
}

export function readJsonEvidence(filename) {
  return filename ? JSON.parse(fs.readFileSync(filename, 'utf8')) : undefined;
}

export function writeCoverageReport(filename, definitions, modelEvidence, capabilityEvidence) {
  const testRoot = path.join(ROOT, 'test');
  const testSources = fs
    .readdirSync(testRoot, { recursive: true })
    .filter((entry) => typeof entry === 'string' && entry.endsWith('.test.ts'))
    .map((entry) => fs.readFileSync(path.join(testRoot, entry), 'utf8'));
  const modelResults = new Map(
    (modelEvidence?.results ?? []).map((result) => [result.tool, result.ok === true]),
  );
  const liveCalls = new Set(
    (capabilityEvidence?.results ?? []).flatMap((result) => [
      ...(result.calls ?? []),
      ...(result.readCalls ?? []),
      ...(result.writeCalls ?? []),
    ]),
  );
  const rows = definitions.map((definition) => {
    const name = definition.function.name;
    const handlerTest = testSources.some((source) => source.includes(definition.factory));
    const effect =
      definition.origin === 'mcp'
        ? 'external process'
        : [
              'write',
              'delete',
              'terminal',
              'headless',
              'git-write',
              'search',
              'fetch',
              'delegate',
            ].includes(definition.permission)
          ? definition.permission
          : 'read-only';
    const modelStatus = modelResults.has(name)
      ? modelResults.get(name)
        ? 'passed'
        : 'failed'
      : 'harness';
    const liveStatus = liveCalls.has(name)
      ? 'handler passed'
      : modelResults.get(name)
        ? 'schema passed'
        : 'opt-in';
    return `| ${name} | ${definition.origin} | ${definition.permission} | yes | ${modelStatus} | ${handlerTest ? 'automated' : 'missing'} | ${liveStatus} | ${effect} |`;
  });
  const markdown = [
    '# Forge Tool Coverage Matrix',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'The inventory and permissions come from the constructors registered by `registerAllTools.ts`. “Harness” means schema emission is available but not executed by default.',
    '',
    '| Tool | Origin | Permission | Coordinator | Model schema test | Handler test | Live test | Side effect |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, markdown, 'utf8');
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function isToolDefinition(value) {
  return (
    value?.type === 'function' &&
    typeof value.function?.name === 'string' &&
    typeof value.function?.description === 'string' &&
    value.function?.parameters &&
    typeof value.function.parameters === 'object'
  );
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return undefined;
}

function expressionToValue(expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(expression) && ts.isNumericLiteral(expression.operand)) {
    const value = Number(expression.operand.text);
    return expression.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
  if (ts.isTemplateExpression(expression)) {
    return (
      expression.head.text +
      expression.templateSpans
        .map((span) => `\${${span.expression.getText()}}${span.literal.text}`)
        .join('')
    );
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.map((element) => expressionToValue(element));
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const obj = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyName(property.name);
      if (key !== undefined) obj[key] = expressionToValue(property.initializer);
    }
    return obj;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = expressionToValue(expression.left);
    const right = expressionToValue(expression.right);
    if (typeof left === 'string' && typeof right === 'string') return left + right;
  }
  return expression.getText();
}
