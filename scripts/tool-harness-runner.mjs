import fs from 'node:fs';
import yaml from 'js-yaml';
import {
  buildResultError,
  parseSseToolResult,
  parseToolArguments,
  stripSource,
  structuralArgsEqual,
  synthesizeArgs,
  validateAgainstSchema,
} from './tool-harness-core.mjs';

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
  show_diff: {
    original_path: 'package.json',
    modified_path: 'package.json',
    title: 'Forge Tool Test',
  },
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
  move_file: {
    source: '.forge/tool-test-write.txt',
    destination: '.forge/tool-test-dir/tool-test-write.txt',
  },
  delete_file: { path: '.forge/tool-test-dir/tool-test-write.txt', recursive: false },
  format_file: { path: 'package.json' },
  rename_symbol: {
    path: 'src/tools/ToolRegistry.ts',
    line: 16,
    character: 13,
    new_name: 'ToolRegistryRenamedForTest',
  },
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
  apply_line_edits: {
    path: '.forge/tool-test-write.txt',
    operations: [
      {
        start_line: 1,
        end_line: 1,
        expected_lines: ['Forge tool-call smoke test'],
        replacement_lines: ['Forge tool-call smoke test updated'],
      },
    ],
  },
  ask_local_agent: { model: 'secondary-local-model', task: 'Review ToolRegistry permissions.' },
  list_worker_models: {},
  dispatch_workers: {
    workers: [
      { id: 'audit-reader', model: 'local-model', task: 'Inspect ToolRegistry.', access: 'read' },
    ],
  },
};

export async function discoverModel(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/models`);
  if (!response.ok) throw new Error(`GET /v1/models failed: HTTP ${response.status}`);
  const data = await response.json();
  const model = data?.data?.[0]?.id || data?.models?.[0]?.name || data?.models?.[0]?.model;
  if (!model) throw new Error('No model returned by /v1/models');
  return model;
}

export async function discoverServerMetadata(baseUrl) {
  const response = await fetch(`${baseUrl}/props`);
  if (!response.ok) return { version: `not reported (HTTP ${response.status})` };
  const props = await response.json();
  return {
    version: props?.version ?? props?.build_info ?? 'not reported by /props',
    buildInfo: props?.build_info,
  };
}

export function configuredCapabilities(configPath, model) {
  if (!fs.existsSync(configPath)) return { configAvailable: false };
  const document = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const baseName = model.split('@', 1)[0];
  const entry = Array.isArray(document?.models)
    ? document.models.find((candidate) => candidate?.name === baseName)
    : undefined;
  return {
    configAvailable: true,
    modelFound: entry !== undefined,
    visionProjectorConfigured:
      typeof entry?.mmproj_path === 'string' && entry.mmproj_path.length > 0,
    declaredCapabilities: Array.isArray(entry?.capabilities) ? entry.capabilities : [],
  };
}

export async function testTool(baseUrl, model, definition, options) {
  let lastResult;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    lastResult = await testToolOnce(baseUrl, model, definition, options, attempt);
    if (lastResult.ok) return lastResult;
  }
  return lastResult;
}

async function testToolOnce(baseUrl, model, definition, options, attempt) {
  const expectedArgs =
    EXAMPLE_ARGS[definition.function.name] ?? synthesizeArgs(definition.function.parameters);
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
  let response;
  let raw;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
    raw = await response.text();
  } catch (error) {
    return failure(
      definition,
      attempt,
      expectedArgs,
      `Request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    return failure(
      definition,
      attempt,
      expectedArgs,
      `HTTP ${response.status}: ${raw.slice(0, 1000)}`,
      response.status,
    );
  }
  const parsed = parseSseToolResult(raw);
  const call = parsed.toolCalls[0];
  if (!call) {
    return {
      ...failure(definition, attempt, expectedArgs, 'No native tool_call emitted', response.status),
      finishReason: parsed.finishReason,
      content: parsed.content.slice(0, 1000),
      reasoning: parsed.reasoning.slice(0, 1000),
    };
  }
  const argumentParse = parseToolArguments(call.function.arguments);
  if (!argumentParse.valid) {
    return {
      ...failure(
        definition,
        attempt,
        expectedArgs,
        `Tool arguments are not valid JSON: ${argumentParse.error}`,
        response.status,
      ),
      nativeCallEmitted: true,
      expectedToolName: call.function.name === definition.function.name,
      emittedName: call.function.name,
      emittedArguments: call.function.arguments,
      finishReason: parsed.finishReason,
    };
  }
  const actualArgs = argumentParse.value;
  const nameOk = call.function.name === definition.function.name;
  const schemaErrors = validateAgainstSchema(actualArgs, definition.function.parameters);
  const schemaOk = schemaErrors.length === 0;
  const argsOk = structuralArgsEqual(actualArgs, expectedArgs);
  return {
    tool: definition.function.name,
    ok: nameOk && schemaOk && (!options.strictArgs || argsOk),
    attempt,
    status: response.status,
    error: buildResultError({
      nameOk,
      schemaOk,
      argsOk,
      strictArgs: options.strictArgs,
      emittedName: call.function.name,
      schemaErrors,
    }),
    emittedName: call.function.name,
    emittedArguments: actualArgs,
    expectedArgs,
    exactArgs: argsOk,
    nativeCallEmitted: true,
    expectedToolName: nameOk,
    argumentsJsonValid: true,
    argumentsStructurallyEqual: argsOk,
    schemaValid: schemaOk,
    schemaErrors,
    finishReason: parsed.finishReason,
    content: options.verbose ? parsed.content.slice(0, 1000) : undefined,
    reasoning: options.verbose ? parsed.reasoning.slice(0, 1000) : undefined,
  };
}

function failure(definition, attempt, expectedArgs, error, status = 0) {
  return {
    tool: definition.function.name,
    ok: false,
    attempt,
    status,
    error,
    nativeCallEmitted: false,
    expectedToolName: false,
    argumentsJsonValid: false,
    schemaValid: false,
    argumentsStructurallyEqual: false,
    expectedArgs,
  };
}
