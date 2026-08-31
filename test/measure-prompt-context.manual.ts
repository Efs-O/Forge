// Measurement (not a passing test): per-component context cost of one Forge
// agent turn for the active model in this workspace's real .forge/config.yaml.
//
//   Temporarily rename this file to measure-prompt-context.test.ts, then run:
//   vitest run test/measure-prompt-context.test.ts
//
// Components measured (chars = exact on-wire size, tokens = Qwen3 tokenizer
// when llama-tokenize.exe is reachable, else chars/3.5 estimate):
//   1. system prompt (execute.njk + FORGE.md + workspace root)
//   2. native tool definitions (real registry + real config + ToolBudget)
//   3. HalluScribe MCP tool definitions (real MCP server tools/list)
//
// Reported in BOTH demand-loading states (see src/tools/lazyToolGroups.ts):
// halluscribe unloaded (a fresh conversation) and activated (after the model
// has called load_tool_group).
import { describe, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config/ConfigLoader';
import { resolveRequestModel } from '../src/config/ConfigResolver';
import { TemplateEngine } from '../src/llm/TemplateEngine';
import { ToolRegistry } from '../src/tools/ToolRegistry';
import { ToolBudget } from '../src/tools/ToolBudget';
import { UserQuestionService } from '../src/sidebar/UserQuestionService';
import { UserNotificationService } from '../src/sidebar/UserNotificationService';
import { registerAllTools } from '../src/tools/registerAllTools';
import { recordLazyGroupTool, resetLazyToolGroups } from '../src/tools/lazyToolGroups';
import type { LocalDelegationService } from '../src/delegation/LocalDelegationService';
import type { IndexManager } from '../src/search/IndexManager';
import type { ToolPermission } from '../src/tools/ToolRegistry';

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = 'n:\\vs code apps\\Forge';
const GGUF = 'N:/QWEN GGUF/Qwen3.8-27B/Qwen3.8-27B-UD-Q3_K_XL.gguf';
const TOKENIZE_EXE = 'C:\\Program Files (x86)\\Llamacpp\\llama.cpp-b10673\\llama-tokenize.exe';

const ALL_PERMISSIONS = new Set<ToolPermission>([
  'read',
  'write',
  'delete',
  'terminal',
  'headless',
  'search',
  'fetch',
  'git-read',
  'git-write',
  'delegate',
  'cloud-worker',
]);
const VISION_ONLY = new Set(['view_image', 'view_video']);

function charsToTokens(chars: number): number {
  return Math.round(chars / 3.5);
}

let tokenizeChecked = false;
function tokenize(text: string): number | null {
  if (!tokenizeChecked) {
    tokenizeChecked = true;
    if (!fs.existsSync(TOKENIZE_EXE)) return null;
  }
  const r = spawnSync(TOKENIZE_EXE, ['-m', GGUF, '--stdin', '--show-count'], {
    input: text,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  // --show-count appends "Total number of tokens: N" as the final line.
  const m = /Total number of tokens:\s*(\d+)/.exec(r.stdout ?? '');
  return m ? Number(m[1]) : null;
}

function mcpTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
  const exe = 'C:\\Users\\efso office\\.halluscribe-mcp\\halluscribe-mcp.exe';
  const script = [
    'const { spawn } = require("child_process");',
    'const child = spawn(process.argv[1], [], { stdio: ["pipe", "pipe", "pipe"] });',
    'let buf = ""; let id = 0; const pending = new Map();',
    'child.stdout.on("data", (d) => { buf += d.toString("utf8"); let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} } });',
    'function rpc(method, params) { return new Promise((res) => { const myId = ++id; pending.set(myId, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\\n"); }); }',
    '(async () => { await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "forge-measure", version: "0" } }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n"); const list = await rpc("tools/list", {}); console.log(JSON.stringify((list.result && list.result.tools) || [])); child.kill(); process.exit(0); })().catch(() => { child.kill(); process.exit(1); });',
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', script, exe], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return [];
  }
}

describe('prompt context measurement', () => {
  it('breaks down the static per-turn context cost', async () => {
    const t0 = Date.now();
    const config = loadConfig(path.join(ROOT, '.forge'));
    const model = resolveRequestModel(config, config.active_model);

    // ── 1. system prompt ──────────────────────────────────────────────────
    const engine = new TemplateEngine(path.join(ROOT, 'config', 'templates', 'builtin'));
    const forgeMd = fs.existsSync(path.join(ROOT, 'FORGE.md'))
      ? fs.readFileSync(path.join(ROOT, 'FORGE.md'), 'utf8')
      : '';
    const systemPrompt = engine.render('execute', {
      workspaceRoot: WORKSPACE,
      forgeInstructions: forgeMd,
      ...(config.custom_instructions ? { customInstructions: config.custom_instructions } : {}),
    });

    // ── 2. MCP tool definitions (fetched first) ───────────────────────────
    // The real tools/list has to be in hand before the native definitions are
    // read: load_tool_group withholds its own schema until a lazy group is
    // actually bridged in, exactly as it does at runtime.
    const mcp = mcpTools();
    resetLazyToolGroups();
    for (const t of mcp) recordLazyGroupTool('halluscribe', t.name);

    // ── 3. native tool definitions ────────────────────────────────────────
    const registry = new ToolRegistry();
    const workspaceState = { get: () => undefined, update: async () => undefined } as never;
    const secrets = { get: async () => undefined } as never;
    const indexManager = { search: async () => [] } as unknown as IndexManager;
    const delegation = { ask: async () => '' } as unknown as LocalDelegationService;
    registerAllTools(
      registry,
      workspaceState,
      secrets,
      config.search,
      indexManager,
      new UserQuestionService(),
      new UserNotificationService(),
      delegation,
      () => config,
    );
    const budget = new ToolBudget(model);
    const nativeDefinitions = budget.filterDefinitions(
      registry.definitions(ALL_PERMISSIONS).filter((d) => !VISION_ONLY.has(d.function.name)),
    );

    const mcpDefs = budget.filterDefinitions(
      mcp.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.inputSchema ?? {},
        },
      })),
    );
    // Split out so the permanent cost of the experiment is a line of its own.
    const discoveryDefs = nativeDefinitions.filter((d) => d.function.name === 'load_tool_group');
    const plainNativeDefs = nativeDefinitions.filter((d) => d.function.name !== 'load_tool_group');
    const nativeJson = JSON.stringify(plainNativeDefs);
    const discoveryJson = JSON.stringify(discoveryDefs);
    const mcpJson = JSON.stringify(mcpDefs);

    // ── totals (exact token counts via llama-tokenize) ─────────────────────
    const sysTok = tokenize(systemPrompt);
    const nativeTok = tokenize(nativeJson);
    const discoveryTok = discoveryDefs.length > 0 ? tokenize(discoveryJson) : 0;
    const mcpTok = tokenize(mcpJson);

    const rows = [
      {
        component: 'system prompt (execute.njk + FORGE.md)',
        chars: systemPrompt.length,
        tok: sysTok,
      },
      {
        component: `native tools (${plainNativeDefs.length} advertised)`,
        chars: nativeJson.length,
        tok: nativeTok,
      },
      {
        component: `load_tool_group (discovery, always on)`,
        chars: discoveryDefs.length > 0 ? discoveryJson.length : 0,
        tok: discoveryTok,
      },
      {
        component: `halluscribe MCP tools (${mcpDefs.length}, on demand)`,
        chars: mcpJson.length,
        tok: mcpTok,
      },
    ];
    const unloadedChars =
      systemPrompt.length +
      nativeJson.length +
      (discoveryDefs.length > 0 ? discoveryJson.length : 0);
    const unloadedTok = (sysTok ?? 0) + (nativeTok ?? 0) + (discoveryTok ?? 0);
    const activatedChars = unloadedChars + mcpJson.length;
    const activatedTok = unloadedTok + (mcpTok ?? 0);

    const lines: string[] = [];
    lines.push('=== FORGE PROMPT CONTEXT MEASUREMENT ===');
    lines.push(`active_model: ${config.active_model}`);
    const spawnNumCtx =
      (model as { spawn?: { num_ctx?: number } }).spawn?.num_ctx ??
      (model as { num_ctx?: number }).num_ctx;
    lines.push(`num_ctx (spawn): ${spawnNumCtx ?? '?'}`);
    lines.push('');
    for (const r of rows) {
      const tok =
        r.tok !== null
          ? String(r.tok).padStart(6)
          : `~${String(charsToTokens(r.chars)).padStart(6)}`;
      lines.push(`${r.component.padEnd(42)} ${String(r.chars).padStart(8)} chars  ${tok} tok`);
    }
    lines.push('');
    lines.push(
      `${'TOTAL static -- halluscribe UNLOADED'.padEnd(42)} ${String(unloadedChars).padStart(8)} chars  ${String(unloadedTok).padStart(6)} tok`,
    );
    lines.push(
      `${'TOTAL static -- halluscribe ACTIVATED'.padEnd(42)} ${String(activatedChars).padStart(8)} chars  ${String(activatedTok).padStart(6)} tok`,
    );
    lines.push(
      `${'recovered on a conversation that never'.padEnd(42)} ${String(activatedChars - unloadedChars).padStart(8)} chars  ${String(activatedTok - unloadedTok).padStart(6)} tok`,
    );
    lines.push(`${'  asks about past sessions'}`);
    lines.push('');
    lines.push(`--- per native tool (chars / exact tokens of its JSON) ---`);
    const perTool = nativeDefinitions
      .map((d) => ({
        name: d.function.name,
        chars: JSON.stringify(d).length,
        tok: tokenize(JSON.stringify(d)),
      }))
      .sort((a, b) => b.chars - a.chars);
    for (const t of perTool)
      lines.push(
        `${t.name.padEnd(28)} ${String(t.chars).padStart(7)} ch  ${String(t.tok ?? '?').padStart(6)} tok`,
      );
    lines.push(`--- per MCP tool (chars / exact tokens of its JSON) ---`);
    const perMcp = mcpDefs
      .map((d) => ({
        name: d.function.name,
        chars: JSON.stringify(d).length,
        tok: tokenize(JSON.stringify(d)),
      }))
      .sort((a, b) => b.chars - a.chars);
    for (const t of perMcp)
      lines.push(
        `${t.name.padEnd(28)} ${String(t.chars).padStart(7)} ch  ${String(t.tok ?? '?').padStart(6)} tok`,
      );
    lines.push('');
    lines.push(`(elapsed ${Date.now() - t0} ms)`);
    const out = lines.join('\n');
    fs.writeFileSync(path.join(ROOT, 'test', 'prompt-context-measurement.txt'), out);
    // eslint-disable-next-line no-console
    console.log('\n' + out);
  }, 120_000);
});
