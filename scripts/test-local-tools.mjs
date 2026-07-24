#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  discoverMcpDefinitions,
  extractToolDefinitions,
  readJsonEvidence,
  writeCoverageReport,
} from './tool-audit-catalog.mjs';
import {
  configuredCapabilities,
  discoverModel,
  discoverServerMetadata,
  testTool,
} from './tool-harness-runner.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.FORGE_TOOL_TEST_BASE_URL || DEFAULT_BASE_URL,
    model: process.env.FORGE_TOOL_TEST_MODEL || '',
    maxTokens: Number(process.env.FORGE_TOOL_TEST_MAX_TOKENS || 512),
    temperature: Number(process.env.FORGE_TOOL_TEST_TEMPERATURE || 0),
    attempts: Number(process.env.FORGE_TOOL_TEST_ATTEMPTS || 2),
    requestTimeoutMs: Number(process.env.FORGE_TOOL_TEST_REQUEST_TIMEOUT_MS || 180_000),
    tools: [],
    list: false,
    report: '',
    strictArgs: false,
    verbose: false,
    includeMcp: false,
    config: path.join(ROOT, '.forge', 'config.yaml'),
    coverageReport: '',
    modelEvidence: '',
    capabilityEvidence: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') options.baseUrl = requireValue(argv, ++i, arg);
    else if (arg === '--model') options.model = requireValue(argv, ++i, arg);
    else if (arg === '--max-tokens') options.maxTokens = Number(requireValue(argv, ++i, arg));
    else if (arg === '--temperature') options.temperature = Number(requireValue(argv, ++i, arg));
    else if (arg === '--attempts') options.attempts = Number(requireValue(argv, ++i, arg));
    else if (arg === '--request-timeout-ms')
      options.requestTimeoutMs = Number(requireValue(argv, ++i, arg));
    else if (arg === '--tool' || arg === '--tools')
      options.tools.push(
        ...requireValue(argv, ++i, arg)
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      );
    else if (arg === '--report') options.report = requireValue(argv, ++i, arg);
    else if (arg === '--strict-args') options.strictArgs = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--include-mcp') options.includeMcp = true;
    else if (arg === '--config') options.config = path.resolve(requireValue(argv, ++i, arg));
    else if (arg === '--coverage-report')
      options.coverageReport = path.resolve(requireValue(argv, ++i, arg));
    else if (arg === '--model-evidence')
      options.modelEvidence = path.resolve(requireValue(argv, ++i, arg));
    else if (arg === '--capability-evidence')
      options.capabilityEvidence = path.resolve(requireValue(argv, ++i, arg));
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
  if (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs < 1_000) {
    throw new Error('--request-timeout-ms must be a number >= 1000');
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
  --request-timeout-ms   timeout for each model request (default: 180000)
  --report <path>        write a new dated JSON report (never overwrites)
  --strict-args          fail when emitted args differ from the fixture JSON
  --list                 list discovered Forge tools and exit
  --include-mcp          explicitly start configured MCP servers and include their tools
  --config <path>        config.yaml used by --include-mcp (default: .forge/config.yaml)
  --coverage-report <p>  write a canonical Markdown tool coverage matrix
  --model-evidence <p>   merge a completed tool-call JSON report into coverage
  --capability-evidence  merge a completed live-capability JSON report
  --verbose              print returned content/reasoning snippets on failures
`);
}

function printResult(result) {
  const mark = result.ok ? 'PASS' : 'FAIL';
  const detail = result.ok
    ? result.exactArgs === false
      ? ' - args changed but schema-valid'
      : ''
    : ` - ${result.error}`;
  console.log(`${mark.padEnd(4)} ${result.tool}${detail}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const nativeDefinitions = extractToolDefinitions();
  const mcpDefinitions = options.includeMcp
    ? await discoverMcpDefinitions(
        options.config,
        new Set(nativeDefinitions.map((definition) => definition.function.name)),
      )
    : [];
  const definitions = [...nativeDefinitions, ...mcpDefinitions].sort((a, b) =>
    a.function.name.localeCompare(b.function.name),
  );
  if (options.coverageReport) {
    writeCoverageReport(
      options.coverageReport,
      definitions,
      readJsonEvidence(options.modelEvidence),
      readJsonEvidence(options.capabilityEvidence),
    );
    console.log(`Coverage report: ${options.coverageReport}`);
  }
  const selected = options.tools.length
    ? definitions.filter((definition) => options.tools.includes(definition.function.name))
    : definitions;

  if (options.list) {
    for (const definition of definitions) {
      console.log(`${definition.function.name}\t${definition.origin}\t${definition.source}`);
    }
    return;
  }

  const missing = options.tools.filter(
    (name) => !definitions.some((definition) => definition.function.name === name),
  );
  if (missing.length) throw new Error(`Unknown tool(s): ${missing.join(', ')}`);
  if (!selected.length) throw new Error('No tools selected.');

  const model = options.model || (await discoverModel(options.baseUrl));
  const server = await discoverServerMetadata(options.baseUrl);
  console.log(`Forge local tool-call test`);
  console.log(`Endpoint: ${options.baseUrl}`);
  console.log(`Model:    ${model}`);
  console.log(`Tools:    ${selected.length}`);
  console.log(`Origins:  ${nativeDefinitions.length} native, ${mcpDefinitions.length} MCP`);
  console.log('Execution: schema emission only (handlers are not executed)');
  console.log(
    `Mode:     ${options.strictArgs ? 'strict exact arguments' : 'schema-valid native tool calls'}`,
  );
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
    if (!/\d{4}-\d{2}-\d{2}/u.test(path.basename(options.report))) {
      throw new Error('--report filename must include a YYYY-MM-DD date');
    }
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    fs.mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true });
    fs.writeFileSync(
      path.resolve(options.report),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          forgeVersion: packageJson.version,
          endpoint: options.baseUrl,
          model,
          modelCapabilities: configuredCapabilities(options.config, model),
          llamaServer: server,
          attemptsPerTool: options.attempts,
          requestTimeoutMs: options.requestTimeoutMs,
          executionMode: 'schema-emission-only',
          strictArguments: options.strictArgs,
          inventory: { native: nativeDefinitions.length, mcp: mcpDefinitions.length },
          results,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    console.log(`Report: ${options.report}`);
  }

  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`ERROR ${err.message}`);
  process.exitCode = 1;
});
