import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import { EmbeddingClient } from '../../src/search/EmbeddingClient';
import { cosineSimilarity } from '../../src/search/semanticMath';
import { makeReadFileTool, makeWriteFileTool } from '../../src/tools/builtinTools';
import {
  makeFindFilesTool,
  makeListDirectoryTool,
  makeSearchCodeTool,
} from '../../src/tools/dirTools';
import { makeRunTestsTool } from '../../src/tools/execTools';
import { buildFallbackToolInstructions } from '../../src/tools/FallbackToolPrompt';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { makeGitStatusTool } from '../../src/tools/gitTools';
import { makeGetDiagnosticsTool, makeGetDocumentSymbolsTool } from '../../src/tools/lspTools';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';
import { extractFallbackToolCalls } from '../../src/tools/ToolCallFallback';
import {
  ToolRegistry,
  type ToolHandlerContext,
  type ToolPermission,
} from '../../src/tools/ToolRegistry';
import { callLiveModel, runLiveToolLoop } from './liveModelHarness';

const LIVE = process.env['FORGE_LIVE_CAPABILITIES'] === '1';
const ENDPOINT = process.env['FORGE_LIVE_ENDPOINT'] ?? 'http://127.0.0.1:8080';
const EMBEDDING_ENDPOINT = process.env['FORGE_LIVE_EMBEDDING_ENDPOINT'] ?? 'http://127.0.0.1:8091';
const MODEL = process.env['FORGE_LIVE_MODEL'] ?? 'gemma4-26b-a4b-it-iq3s';
const REPORT = process.env['FORGE_LIVE_REPORT'];
const results: Array<Record<string, unknown>> = [];

function contextFor(checkpoint?: ReturnType<CheckpointStack['beginTurn']>): ToolHandlerContext {
  return {
    beforeMutate: (paths) => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      for (const candidate of paths) {
        checkpoint?.snapshotBefore(
          workspaceRoot && !path.isAbsolute(candidate)
            ? path.join(workspaceRoot, candidate)
            : candidate,
        );
      }
    },
  };
}

describe.skipIf(!LIVE)(
  'opt-in Gemma coordinator, delegation, vision, and semantic checks',
  () => {
    let root: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-live-capabilities-'));
      vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    });

    afterEach(() => {
      vscode.workspace.workspaceFolders.splice(0);
      fs.rmSync(root, { recursive: true, force: true });
    });

    afterAll(async () => {
      if (!REPORT) return;
      if (!/\d{4}-\d{2}-\d{2}/u.test(path.basename(REPORT))) {
        throw new Error('FORGE_LIVE_REPORT filename must include a YYYY-MM-DD date');
      }
      const packageJson = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
      ) as { version: string };
      const propsResponse = await fetch(`${ENDPOINT}/props`);
      const props = propsResponse.ok
        ? ((await propsResponse.json()) as Record<string, unknown>)
        : {};
      fs.mkdirSync(path.dirname(REPORT), { recursive: true });
      fs.writeFileSync(
        REPORT,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            forgeVersion: packageJson.version,
            model: MODEL,
            endpoint: ENDPOINT,
            embeddingEndpoint: EMBEDDING_ENDPOINT,
            modelCapabilities: {
              nativeToolCalling: true,
              visionProjector: true,
              embeddingPromptStyle: 'gemma',
            },
            llamaServerVersion: props['build_info'] ?? props['version'] ?? 'not reported',
            attemptsPerRequest: 1,
            executionMode: 'live-capability',
            results,
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
    });

    it('completes a read-edit-test coordinator loop and restores the checkpoint', async () => {
      const target = path.join(root, 'status.txt');
      fs.writeFileSync(target, 'STATUS=old\n', 'utf8');
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({
          scripts: {
            test: `node -e "const fs=require('fs');process.exit(fs.readFileSync('status.txt','utf8').includes('STATUS=done')?0:1)"`,
          },
        }),
        'utf8',
      );
      const registry = new ToolRegistry();
      registry.register(makeReadFileTool());
      registry.register(makeSearchCodeTool());
      registry.register(makeEditFileTool());
      registry.register(makeRunTestsTool());
      const checkpoints = new CheckpointStack();
      const session = checkpoints.beginTurn('live-coordinator');
      const result = await runLiveToolLoop({
        endpoint: ENDPOINT,
        model: MODEL,
        prompt:
          'Read status.txt. Use search_code to find STATUS=old in the workspace. Replace the exact text STATUS=old with STATUS=done using edit_file. Then run the project tests with run_tests. Do not skip any step.',
        registry,
        allowed: new Set<ToolPermission>(['read', 'write', 'headless']),
        context: contextFor(session),
      });
      checkpoints.commitTurn(session);
      expect(result.calls).toEqual(
        expect.arrayContaining(['read_file', 'search_code', 'edit_file', 'run_tests']),
      );
      expect(fs.readFileSync(target, 'utf8')).toBe('STATUS=done\n');
      await expect(checkpoints.undo()).resolves.toEqual([target]);
      expect(fs.readFileSync(target, 'utf8')).toBe('STATUS=old\n');
      results.push({
        check: 'coordinator-loop',
        passed: true,
        calls: result.calls,
        checkpointUndo: true,
      });
    }, 240_000);

    it('sends advisory delegation with zero tools', async () => {
      const message = await callLiveModel(ENDPOINT, MODEL, [
        {
          role: 'user',
          content: 'Context: VALUE=done. Give a one-sentence second opinion on this state.',
        },
      ]);
      expect(message.tool_calls ?? []).toHaveLength(0);
      expect(message.content?.length).toBeGreaterThan(0);
      results.push({ check: 'advisory-delegation', passed: true, toolDefinitionCount: 0 });
    }, 120_000);

    it('grounds a response in the deterministic vision fixture', async () => {
      const image = fs
        .readFileSync(path.resolve(__dirname, '../fixtures/vision-forge-7.png'))
        .toString('base64');
      const message = await callLiveModel(
        ENDPOINT,
        MODEL,
        [{ role: 'user', content: 'Name the shape, its color, and transcribe the text exactly.' }],
        undefined,
        `data:image/png;base64,${image}`,
      );
      expect(message.content?.toLowerCase()).toContain('blue');
      expect(message.content?.toLowerCase()).toContain('triangle');
      expect(message.content).toContain('FORGE 7');
      results.push({
        check: 'vision',
        passed: true,
        groundedTerms: ['blue', 'triangle', 'FORGE 7'],
      });
    }, 180_000);

    it('ranks the known semantic fixture first with Gemma prompt prefixes', async () => {
      const documents = [
        'verify JWT bearer tokens and reject expired authentication claims',
        'render a violet button with CSS border radius',
        'apply a database migration that adds an invoice column',
      ];
      const client = new EmbeddingClient(
        () => EMBEDDING_ENDPOINT,
        () => 'gemma',
      );
      const vectors = await client.embedDocuments(documents);
      const query = await client.embedQuery('token authentication verification');
      const scores = vectors.map((vector, index) => ({
        index,
        score: cosineSimilarity(query, vector),
      }));
      scores.sort((left, right) => right.score - left.score);
      expect(scores[0]?.index).toBe(0);
      results.push({
        check: 'semantic-search',
        passed: true,
        promptStyle: 'gemma',
        topDocument: 0,
      });
    }, 120_000);

    it('handles three prompt phrasings for representative schemas and fallback format', async () => {
      const representativeTools = [
        { tool: makeGitStatusTool(), args: {} },
        {
          tool: makeReadFileTool(),
          args: { path: 'package.json', start_line: 1, end_line: 2 },
        },
      ];
      const promptVariants = [
        (name: string, args: object) =>
          `Call ${name} exactly once with these exact JSON arguments: ${JSON.stringify(args)}. Do not call another tool.`,
        (name: string, args: object) =>
          `Invoke only the ${name} function. Preserve every argument exactly as written: ${JSON.stringify(args)}.`,
        (name: string, args: object) =>
          `Return a native tool call for ${name}, using precisely this argument object and no additions: ${JSON.stringify(args)}.`,
      ];

      for (const { tool, args } of representativeTools) {
        for (const makePrompt of promptVariants) {
          const message = await callLiveModel(
            ENDPOINT,
            MODEL,
            [{ role: 'user', content: makePrompt(tool.definition.function.name, args) }],
            [tool.definition],
          );
          expect(message.tool_calls).toHaveLength(1);
          const call = message.tool_calls?.[0];
          expect(call?.function.name).toBe(tool.definition.function.name);
          expect(JSON.parse(call?.function.arguments ?? '{}')).toEqual(args);
        }
      }

      const fallbackTool = makeReadFileTool().definition;
      const fallbackMessage = await callLiveModel(ENDPOINT, MODEL, [
        { role: 'system', content: buildFallbackToolInstructions([fallbackTool]) },
        {
          role: 'user',
          content:
            'Use read_file for package.json, lines 1 through 2. Follow the exact fenced JSON format.',
        },
      ]);
      const fallbackCalls = extractFallbackToolCalls(fallbackMessage.content ?? '');
      expect(fallbackCalls).toHaveLength(1);
      expect(fallbackCalls?.[0]?.function.name).toBe('read_file');
      expect(JSON.parse(fallbackCalls?.[0]?.function.arguments ?? '{}')).toEqual({
        path: 'package.json',
        start_line: 1,
        end_line: 2,
      });
      results.push({
        check: 'prompt-variants-and-fallback',
        passed: true,
        promptVariantsPerSchema: 3,
        representativeTools: representativeTools.map(({ tool }) => tool.definition.function.name),
        fallbackFormat: true,
      });
    }, 300_000);
  },
);
