#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';

const TOOL_SOURCE_FILES = [
  'src/tools/builtinTools.ts',
  'src/tools/dirTools.ts',
  'src/tools/lspTools.ts',
  'src/tools/uxTools.ts',
  'src/tools/fetchTool.ts',
  'src/tools/memoryTools.ts',
  'src/tools/searchTool.ts',
  'src/tools/semanticSearchTool.ts',
  'src/tools/fileEditTools.ts',
  'src/tools/execTools.ts',
  'src/tools/gitTools.ts',
];

const EXAMPLE_ARGS = {
  read_file: { path: 'package.json', start_line: 1, end_line: 20 },
  write_file: { path: '.forge/tool-test-write.txt', content: 'Forge tool-call smoke test\n' },
  replace_selection: { text: 'Forge tool-call smoke test' },
  insert_code: { text: '// Forge tool-call smoke test', line: 0 },
  list_directory: { path: 'src' },
  find_files: { pattern: 'src/**/*.ts', max_results: 5 },
  search_code: { query: 'ToolRegistry', include: 'src/**/*.ts', max_results: 5 },
  search_codebase: { query: 'tool registry dispatch', top_k: 3, scope_glob: 'src/**/*.ts' },
  get_diagnostics: { path: 'src/extension.ts' },
  get_document_symbols: { path: 'src/tools/ToolRegistry.ts' },
  get_workspace_symbols: { query: 'ToolRegistry' },
  get_hover: { path: 'src/tools/ToolRegistry.ts', line: 16, character: 13 },
  go_to_definition: { path: 'src/tools/ToolRegistry.ts', line: 16, character: 13 },
  find_references: { path: 'src/tools/ToolRegistry.ts', line: 16, character: 13 },
  show_diff: { original_path: 'package.json', modified_path: 'package.json', title: 'Forge Tool Test' },
  ask_user: { prompt: 'Forge tool-call smoke test prompt', placeholder: 'test' },
  show_notification: { message: 'Forge tool-call smoke test', level: 'info' },
  copy_to_clipboard: { text: 'Forge tool-call smoke test' },
  read_clipboard: {},
  open_url_in_browser: { url: 'https://example.com/' },
  web_fetch: { url: 'https://example.com/', max_chars: 1000 },
  web_search: { query: 'Forge LLM local model tool calling' },
  remember: { key: 'tool-test', value: 'Forge tool-call smoke test' },
  recall: { key: 'tool-test' },
  list_memories: {},
  replace_in_file: {
    filepath: '.forge/tool-test-write.txt',
    old_str: 'Forge tool-call smoke test',
    new_str: 'Forge tool-call smoke test updated',
  },
  create_directory: { path: '.forge/tool-test-dir' },
  move_file: { source: '.forge/tool-test-write.txt', destination: '.forge/tool-test-dir/tool-test-write.txt' },
  delete_file: { path: '.forge/tool-test-dir/tool-test-write.txt', recursive: false },
  format_file: { path: 'package.json' },
  rename_symbol: { path: 'src/tools/ToolRegistry.ts', line: 16, character: 13, new_name: 'ToolRegistryRenamedForTest' },
  run_terminal: { command: 'npm run type-check', cwd: '.' },
  exec_command: { command: 'node', args: ['--version'], cwd: '.', timeout_ms: 10000 },
  run_tests: { pattern: 'test/unit/ToolCallFallback.test.ts', reporter: 'verbose' },
  run_build: { script: 'build' },
  git_status: {},
  git_log: { max_entries: 3 },
  git_diff: { path: 'src/sidebar/AgentLoop.ts', staged: false },
  git_blame: { path: 'src/tools/ToolRegistry.ts' },
  git_show: { ref: 'HEAD' },
  create_branch: { name: 'forge-tool-test-branch', from: 'HEAD' },
  switch_branch: { name: 'main' },
  stage: { paths: ['src/tools/ToolRegistry.ts'] },
  commit: { message: 'Forge tool-call smoke test' },
};

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.FORGE_TOOL_TEST_BASE_URL || DEFAULT_BASE_URL,
    model: process.env.FORGE_TOOL_TEST_MODEL || '',
    maxTokens: Number(process.env.FORGE_TOOL_TEST_MAX_TOKENS || 512),
    temperature: Number(process.env.FORGE_TOOL_TEST_TEMPERATURE || 0),
    attempts: Number(process.env.FORGE_TOOL_TEST_ATTEMPTS || 2),
    tools: [],
    list: false,
    report: '',
    strictArgs: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') options.baseUrl = requireValue(argv, ++i, arg);
    else if (arg === '--model') options.model = requireValue(argv, ++i, arg);
    else if (arg === '--max-tokens') options.maxTokens = Number(requireValue(argv, ++i, arg));
    else if (arg === '--temperature') options.temperature = Number(requireValue(argv, ++i, arg));
    else if (arg === '--attempts') options.attempts = Number(requireValue(argv, ++i, arg));
    else if (arg === '--tool' || arg === '--tools') options.tools.push(...requireValue(argv, ++i, arg).split(',').map((v) => v.trim()).filter(Boolean));
    else if (arg === '--report') options.report = requireValue(argv, ++i, arg);
    else if (arg === '--strict-args') options.strictArgs = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.maxTokens) || options.maxTokens < 32) {
    throw new Error('--max-tokens must be a number >= 32');
  }
  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new Error('--attempts must be an integer >= 1');
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/test-local-tools.mjs [options]

Tests the currently loaded llama-server model against Forge tool schemas.
It asks the model to emit tool calls only; it does not execute Forge tools.

Options:
  --base-url <url>       llama-server base URL (default: ${DEFAULT_BASE_URL})
  --model <id>           model id (default: first /v1/models entry)
  --tool <name[,name]>   limit to one or more tool names
  --max-tokens <n>       completion token budget per tool (default: 512)
  --temperature <n>      sampling temperature (default: 0)
  --attempts <n>         attempts per tool before failing (default: 2)
  --report <path>        write JSON report
  --strict-args          fail when emitted args differ from the fixture JSON
  --list                 list discovered Forge tools and exit
  --verbose              print returned content/reasoning snippets on failures
`);
}

function extractToolDefinitions() {
  const definitions = [];
  for (const relativePath of TOOL_SOURCE_FILES) {
    const filename = path.join(ROOT, relativePath);
    const text = fs.readFileSync(filename, 'utf8');
    const sourceFile = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    visit(sourceFile, (node) => {
      if (!ts.isPropertyAssignment(node)) return;
      if (propertyName(node.name) !== 'definition') return;
      const value = expressionToValue(node.initializer);
      if (isToolDefinition(value)) {
        definitions.push({ ...value, source: relativePath });
      }
    });
  }

  const seen = new Set();
  return definitions.filter((definition) => {
    const name = definition.function.name;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function isToolDefinition(value) {
  return value?.type === 'function' &&
    typeof value.function?.name === 'string' &&
    typeof value.function?.description === 'string' &&
    value.function?.parameters &&
    typeof value.function.parameters === 'object';
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function expressionToValue(expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isPrefixUnaryExpression(expression) && ts.isNumericLiteral(expression.operand)) {
    const value = Number(expression.operand.text);
    return expression.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }

  if (ts.isTemplateExpression(expression)) {
    return expression.head.text + expression.templateSpans.map((span) => `\${${span.expression.getText()}}${span.literal.text}`).join('');
  }

  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.map((element) => expressionToValue(element));
  }

  if (ts.isObjectLiteralExpression(expression)) {
    const obj = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyName(property.name);
      if (key === undefined) continue;
      obj[key] = expressionToValue(property.initializer);
    }
    return obj;
  }

  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = expressionToValue(expression.left);
    const right = expressionToValue(expression.right);
    if (typeof left === 'string' && typeof right === 'string') return left + right;
  }

  return expression.getText();
}

async function discoverModel(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/models`);
  if (!response.ok) throw new Error(`GET /v1/models failed: HTTP ${response.status}`);
  const data = await response.json();
  const model = data?.data?.[0]?.id || data?.models?.[0]?.name || data?.models?.[0]?.model;
  if (!model) throw new Error('No model returned by /v1/models');
  return model;
}

async function testTool(baseUrl, model, definition, options) {
  let lastResult;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    lastResult = await testToolOnce(baseUrl, model, definition, options, attempt);
    if (lastResult.ok) return lastResult;
  }
  return lastResult;
}

async function testToolOnce(baseUrl, model, definition, options, attempt) {
  const expectedArgs = EXAMPLE_ARGS[definition.function.name] ?? synthesizeArgs(definition.function.parameters);
  const body = {
    model,
    stream: true,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      {
        role: 'system',
        content: [
          'You are testing a tool-calling interface.',
          'Call exactly the requested tool once.',
          'Do not answer in prose.',
          'Use the exact argument JSON provided by the user.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `Call ${definition.function.name} with exactly these arguments:\n${JSON.stringify(expectedArgs)}`,
      },
    ],
    tools: [stripSource(definition)],
  };

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await response.text();

  if (!response.ok) {
    return {
      tool: definition.function.name,
      ok: false,
      attempt,
      status: response.status,
      error: `HTTP ${response.status}: ${raw.slice(0, 1000)}`,
      expectedArgs,
    };
  }

  const parsed = parseSseToolResult(raw);
  const call = parsed.toolCalls[0];
  if (!call) {
    return {
      tool: definition.function.name,
      ok: false,
      attempt,
      status: response.status,
      error: 'No native tool_call emitted',
      expectedArgs,
      finishReason: parsed.finishReason,
      content: parsed.content.slice(0, 1000),
      reasoning: parsed.reasoning.slice(0, 1000),
    };
  }

  let actualArgs;
  try {
    actualArgs = JSON.parse(call.function.arguments || '{}');
  } catch (err) {
    return {
      tool: definition.function.name,
      ok: false,
      attempt,
      status: response.status,
      error: `Tool arguments are not valid JSON: ${err.message}`,
      emittedName: call.function.name,
      emittedArguments: call.function.arguments,
      expectedArgs,
      finishReason: parsed.finishReason,
    };
  }

  const nameOk = call.function.name === definition.function.name;
  const schemaErrors = validateAgainstSchema(actualArgs, definition.function.parameters);
  const schemaOk = schemaErrors.length === 0;
  const argsOk = JSON.stringify(actualArgs) === JSON.stringify(expectedArgs);
  const ok = nameOk && schemaOk && (!options.strictArgs || argsOk);
  return {
    tool: definition.function.name,
    ok,
    attempt,
    status: response.status,
    error: buildResultError({ nameOk, schemaOk, argsOk, strictArgs: options.strictArgs, emittedName: call.function.name, schemaErrors }),
    emittedName: call.function.name,
    emittedArguments: actualArgs,
    expectedArgs,
    exactArgs: argsOk,
    schemaValid: schemaOk,
    schemaErrors,
    finishReason: parsed.finishReason,
    content: options.verbose ? parsed.content.slice(0, 1000) : undefined,
    reasoning: options.verbose ? parsed.reasoning.slice(0, 1000) : undefined,
  };
}

function buildResultError({ nameOk, schemaOk, argsOk, strictArgs, emittedName, schemaErrors }) {
  if (!nameOk) return `Wrong tool name: ${emittedName}`;
  if (!schemaOk) return `Arguments violate schema: ${schemaErrors.join('; ')}`;
  if (strictArgs && !argsOk) return 'Arguments differ from requested JSON';
  return '';
}

function parseSseToolResult(raw) {
  const toolCalls = new Map();
  let content = '';
  let reasoning = '';
  let finishReason = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
    for (const part of delta.tool_calls || []) {
      const index = part.index ?? 0;
      const acc = toolCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (part.id) acc.id = part.id;
      if (part.type) acc.type = part.type;
      if (part.function?.name) acc.function.name += part.function.name;
      if (part.function?.arguments) acc.function.arguments += part.function.arguments;
      toolCalls.set(index, acc);
    }
  }

  return {
    toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value),
    content,
    reasoning,
    finishReason,
  };
}

function stripSource(definition) {
  return {
    type: definition.type,
    function: definition.function,
  };
}

function synthesizeArgs(parameters) {
  const properties = parameters?.properties || {};
  const required = Array.isArray(parameters?.required) ? parameters.required : Object.keys(properties);
  const args = {};
  for (const key of required) {
    args[key] = synthesizeValue(properties[key], key);
  }
  return args;
}

function synthesizeValue(schema, key) {
  if (schema?.enum?.length) return schema.enum[0];
  if (schema?.type === 'integer' || schema?.type === 'number') return schema.minimum ?? 1;
  if (schema?.type === 'boolean') return false;
  if (schema?.type === 'array') return [synthesizeValue(schema.items, key)];
  if (schema?.type === 'object') return synthesizeArgs(schema);
  if (key.includes('url')) return 'https://example.com/';
  if (key.includes('path') || key.includes('file')) return 'package.json';
  if (key.includes('query')) return 'Forge tool-call test';
  if (key.includes('command')) return 'node';
  return `test_${key}`;
}

function validateAgainstSchema(value, schema, pathName = 'arguments') {
  const errors = [];
  validateValue(value, schema, pathName, errors);
  return errors;
}

function validateValue(value, schema, pathName, errors) {
  if (!schema || typeof schema !== 'object') return;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathName} must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }

  if (type === 'object') {
    if (!isPlainObject(value)) {
      errors.push(`${pathName} must be object`);
      return;
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${pathName}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${pathName}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) validateValue(value[key], childSchema, `${pathName}.${key}`, errors);
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${pathName} must be array`);
      return;
    }
    value.forEach((entry, index) => validateValue(entry, schema.items, `${pathName}[${index}]`, errors));
    return;
  }

  if (type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${pathName} must be integer`);
    return;
  }

  if (type === 'number') {
    if (typeof value !== 'number') errors.push(`${pathName} must be number`);
    return;
  }

  if (type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${pathName} must be boolean`);
    return;
  }

  if (type === 'string' && typeof value !== 'string') {
    errors.push(`${pathName} must be string`);
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function printResult(result) {
  const mark = result.ok ? 'PASS' : 'FAIL';
  const detail = result.ok
    ? result.exactArgs === false ? ' - args changed but schema-valid' : ''
    : ` - ${result.error}`;
  console.log(`${mark.padEnd(4)} ${result.tool}${detail}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const definitions = extractToolDefinitions().sort((a, b) => a.function.name.localeCompare(b.function.name));
  const selected = options.tools.length
    ? definitions.filter((definition) => options.tools.includes(definition.function.name))
    : definitions;

  if (options.list) {
    for (const definition of definitions) {
      console.log(`${definition.function.name}\t${definition.source}`);
    }
    return;
  }

  const missing = options.tools.filter((name) => !definitions.some((definition) => definition.function.name === name));
  if (missing.length) throw new Error(`Unknown tool(s): ${missing.join(', ')}`);
  if (!selected.length) throw new Error('No tools selected.');

  const model = options.model || await discoverModel(options.baseUrl);
  console.log(`Forge local tool-call test`);
  console.log(`Endpoint: ${options.baseUrl}`);
  console.log(`Model:    ${model}`);
  console.log(`Tools:    ${selected.length}`);
  console.log(`Mode:     ${options.strictArgs ? 'strict exact arguments' : 'schema-valid native tool calls'}`);
  console.log('');

  const results = [];
  for (const definition of selected) {
    const result = await testTool(options.baseUrl, model, definition, options);
    results.push(result);
    printResult(result);
  }

  const failed = results.filter((result) => !result.ok);
  console.log('');
  console.log(`Summary: ${results.length - failed.length}/${results.length} passed`);

  if (options.report) {
    fs.writeFileSync(path.resolve(options.report), JSON.stringify({ endpoint: options.baseUrl, model, results }, null, 2));
    console.log(`Report: ${options.report}`);
  }

  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`ERROR ${err.message}`);
  process.exitCode = 1;
});
