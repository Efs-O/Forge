import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import type { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { IndexManager } from '../../src/search/IndexManager';
import type { JobStore } from '../../src/jobs/JobStore';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { registerAllTools } from '../../src/tools/registerAllTools';
import { ALL_TOOL_PERMISSIONS, ToolRegistry } from '../../src/tools/ToolRegistry';
import {
  recordLazyGroupTool,
  recordNativeLazyTool,
  resetLazyToolGroups,
} from '../../src/tools/lazyToolGroups';

/**
 * CI token budget for the native tool schema (TOOL_SCHEMA_GROWTH_PLAN.md, Step 1).
 *
 * The tool schema is a fixed cost on every request: the model re-prefills the
 * whole `tools` array on every round. This test gates that cost so that adding
 * a tool forces a decision *when it is added*, not after the catalog has grown
 * past where it is manageable.
 *
 * The budget is on **characters of `JSON.stringify(definitions)`**, not tokens:
 * CI has no tokenizer. The chars→tokens ratio is recorded next to the constant
 * (measured 2026-09-30 with llama.cpp b11243 and Qwen3.8-27B Q6_K; see the plan
 * doc). The
 * gate is on the **maximally-advertised** set — every optional block enabled —
 * because a config that turns on image_generation / jobs / agent_bus /
 * image_search advertises more tools than a bare one, and that is the case that
 * must stay under the ceiling.
 *
 * The failure message names the two sanctioned responses and the CHANGES.md
 * rule. Raising the ceiling without one of those is the thing this gate exists
 * to stop.
 */

// Reference measurement updated 2026-10-29 (tools-expansion lane F1, item 1.2):
// `edit_file` takes `replace_all` — at the top level and inside each `edits[]`
// item, because one batch often renames an identifier everywhere and fixes one
// line once. +404 chars over lane F1 item 1.1's 60,344, so the gate number is
// 60,748.
// Reference measurement updated 2026-10-29 (tools-expansion lane F1, item 1.1):
// `search_code` now takes `output` ("content" | "files" | "count"), `context`
// (0-10), `ignore_case` and `offset`, because the audit's 1,164 shell greps
// mostly carried `-l`, `-c`, `-i` and `-A`/`-B` and this tool could answer none
// of them. +925 chars on the 89-tool catalog over the 59,419 that lane B's
// `write_file` description fix measured, so the gate number is 60,344 — still
// under the 64,625 ceiling, with 4,281 chars of headroom left for lanes F2 and
// the parts still queued.
// Reference measurement updated 2026-10-29 (skills lane F2): `load_skill` is
// registered and advertised, +455 chars on the 89-tool catalog (90 tools, the
// 300-char description plus the one-argument schema), so the gate number is
// 61,203. Skills are on unless `skills.enabled: false`; the maximal config
// below includes `load_skill` and measures the advertised cost.
// Reference measurement updated 2026-10-29 (tool-trim lane B, follow-up to B2):
// `write_file`'s top-level description no longer says that `mode "append"` adds
// to the end — the hold-back strips the `mode` property from the offer until a
// call is cut off, so a sentence beside it must not keep advertising the choice
// on every round. -52 chars on the 89-tool catalog, so the gate number is 59,419.
// Reference measurement updated 2026-10-29 (tool-trim lane A, items A3+A4):
// `read_file` takes `reads` — up to 10 `{path, start_line?, end_line?}` items
// in one call, because 901 shell commands read files in the 53 sessions since
// 0.17.80 and `sed -n` was in 639 of them, one round covering several ranges.
// +1,057 chars on the 89-tool catalog over lane B's 58,390 made 59,447; A4 then
// dropped `create_directory` from the `files` group map and the word "mkdir"
// from that group's purpose line, which is +24 chars on `load_tool_group`'s
// description, so the gate number is 59,471. The "65-tool" title is still
// exact: 89 registered tools minus the 24 browser/desktop schemas held out
// pending the owner's decision.
// Reference measurement updated 2026-10-29 (tool-trim lane B, items B2+B3):
// `append_file` and `create_directory` are gone — `write_file` carries both jobs
// (`mode: "append"`, and the parents every write makes), so the catalog is 89
// tools and 58,390 chars: 412 less than the 58,802 at B2, and 617 less than the
// 59,007 lane A measured earlier the same day. Measured with lane A's
// uncommitted A3 out of the tree, so it is what this commit checks out to;
// A4 re-measures once A3 is in.
// Reference measurement updated 2026-10-29 (tool-trim lane A, items A1+A2):
// `media` is no longer advertised by default and `render_html_to_image` joined
// the group, and `git_read` moved into `git`, so both purpose lines now carry
// their verbs — +87 then +47 chars on `load_tool_group`'s description, making
// the non-computer-use catalog 59,007. Re-measured in A4 once A3 and lane B's
// commits are in.
// Reference measurement updated 2026-10-29: the 65-tool non-computer-use
// catalog is 58,873 chars, 7 fewer than the 58,880 of earlier that day, because
// `install_llamacpp` now names the typed `/restart` instead of the stale
// `/restartBackend`. The 58,880 was 58,801 plus 79 for `message_chat`'s one
// `view` clause saying it also reads a closed chat and marks the result
// `closed`.
// (2026-10-28: 58,741 after 0.17.93's `message_chat` actions and the
// non-blocking `ask_agent` description, then 58,801 from that day's
// `message_chat` send-duplication fix and 12,000-character message cap.
// 2026-10-24: 58,149, when the eager `message_chat` schema raised the
// 57,500-char ceiling to 58,750.)
// The ≈4.62 chars/token ratio was measured 2026-09-30 with llama.cpp b11243
// and Qwen3.8-27B Q6_K (50,439 chars / 10,913 tokens).
// 2026-10-29: 62,501 after merging lane C's `export_document` (91 tools) onto
// main's `load_skill` and edit-diagnostics schemas (61,203 on 90 tools).
// 2026-10-30: 62,883, +382. `notify_on_exit` is on by default for a background
// command, so its description now states the default, the `false` opt-out and
// the case where a stopped turn sends no notice; `monitor_execution` and `wait`
// point at the automatic wake instead of at the flag. Still 1,742 under the
// 64,625 ceiling, so nothing here had to be paid for by cutting another tool.
// 2026-10-30: 62,978 after merging `find_files.include_ignored` (+95 chars)
// from fix/tool-error-fixes onto the above.
// 2026-11-04: 63,100 (+35) after naming video and music generation in the media
// tool-group description; recorded with the shipped feature in CHANGES.md.
// 2026-11-05: 63,092 (−8) after removing the Brave provider: `web_search`'s
// `provider` enum lost the `"brave"` member and its comma.
// 2026-11-05: 63,628 (+536) after clarifying tool fields and failure guidance
// for shell, message_chat, and ask_agent; still under the 64,625-char ceiling.
// 2026-11-05: 63,554 (-74) after review removed duplicate ask_agent wording and added the shell timeout default; 1,071 below the ceiling.
// 2026-11-05: 63,689 (+135) after the media group line named checking your own rendered work and headless rendering.
// 2026-11-08: 63,789 (+117) after the message_chat description named other Forge
// windows on this machine and the id-only rule for their chats; 836 below the ceiling.
// 2026-11-08: 64,604 (+815) — the maximal config now turns `permissions.chats`
// on, so the ceiling prices the two gated actions and their `model`/`window`
// fields as well as the ungated catalog. A window that enables them sits 21
// chars under the ceiling; one that does not is what the older number measured.
// 2026-11-10: 65,243 (-31) after making remember's description optional and removing its cap.
// 2026-11-10: 65,278 after restoring full message_chat routing guidance.
// 2026-11-10: 65,567 with both merged.
// 2026-11-10: 67,121 after naming lazy-group members so tools can be found by name.
// 2026-11-10: 67,593 after documenting consistent cwd and file path resolution for Git tools.
// 2026-11-10: 67,814 (+221) after the shell description says when and how to elevate on Windows.
// 2026-11-11: 67,825 (+11) after clarifying which code actions can be applied.
// 2026-11-11: unchanged after browser_scroll gained into_view; browser schemas are excluded below.
// 2026-11-11: 67,929 (+104) after clarifying shell cwd, notebook formats and video sampling.
// 2026-11-11: 67,962 (+33, merged) after adding branch context to git_read status and describing the editing-only code_intel group.
// 2026-11-11: 67,978 (+16, merged) after saying attended Clanker approves manage_jobs delete.
// 2026-11-11: 68,000 (+22, merged) after message_chat list described all chats and list_executions marked this chat's runs.
// 2026-11-11: 67,984 (-16, merged) after diagnostics editor scope and shared editor context.
// 2026-11-11: 66,897 (-1,087) after removing install_llamacpp (the llamacpp_update job covers it).
// 2026-11-11: 67,049 (+152) after manage_jobs names the fields create requires (Group F).
// 2026-11-11: 67,102 (+53) after manage_jobs says the job definition goes in definition.
// 2026-11-11: 67,283 (+181) after shell says Git Bash turns a lone /switch into a path (lab pass 2 group D).
// 2026-11-11: 67,429 (+146) after show_diff says its result carries no diff text.
const MEASURED_CHARS = 67_429;
// 2026-11-09: 64,954 (+64) after read_tool_result clarified that message_index
// reads tool results and tool_call_id accepts a unique prefix.
// Phase 3 STOP: the historical full 88-tool wire schema was 67,128 chars.
// Exclude computer_use (24 browser/desktop schemas) pending the owner's product
// decision; the full and gated sizes are recorded in the report.
const COMPUTER_USE_TOOLS_EXCLUDED_PENDING_DECISION = ['browser_', 'desktop_'] as const;
// Ceiling a little above the measured size, so a single small update does not
// trip it, but a batch of new tools or large description growth does. Raised
// 55,483 → 56,600 on 2026-10-13 (CHANGES.md 0.17.22): the
// two additions are opt-in image tools, advertised only when configured.
// Raised 56,600 → 57,500 for `set_checkin`, then 57,500 → 58,750 for the
// required eager `message_chat` tool (CHANGES.md 0.17.73), then by 10%,
// 58,750 → 64,625, on 2026-10-28 (owner's call, CHANGES.md Unreleased): the
// catalog sat 9 chars under the old ceiling, so every description fix had to
// be paid for by cutting another one.
// Raised to 65,000 for the optional `stage.cwd` argument (CHANGES.md Unreleased):
// nested-repository paths can name their base, and the old budget had only
// 21 chars of headroom.
// 2026-11-10: raised to 68,000 because lazy-group member names are required for
// a model to find a requested tool's group; measured schema is 67,121 chars.
const TOOL_SCHEMA_CHAR_BUDGET = 68_000;

const ALL_PERMISSIONS = new Set(ALL_TOOL_PERMISSIONS);

/**
 * A config that enables every optional tool block, so the maximally-advertised
 * set is produced. `.forge/config.yaml` is gitignored and absent in CI, so this
 * synthetic config is the only way to reach the worst case deterministically.
 */
function maximalConfig(): ForgeConfig {
  return {
    active_model: 'primary',
    llama_server: { binary: 'llama-server' },
    models: [
      { name: 'primary', gguf_path: '/primary.gguf' },
      { name: 'worker', gguf_path: '/worker.gguf' },
    ],
    image_generation: {
      output_dir: 'generated-images',
      backends: [{ name: 'grok', provider: 'xai', model: 'img', confirm_each: true }],
      // The worst case includes the upscale block: `upscale_image` is only
      // registered when it is configured, so pricing the maximally-advertised
      // set means pricing it with the block present.
      upscale: {
        binary: '/models/sd-cli.exe',
        model: '/models/ESRGAN/4x_foolhardy_Remacri.pth',
        cuda_device: 0,
        timeout_ms: 300_000,
        min_free_vram_mb: 1_500,
        max_input_edge_px: 2_048,
      },
    } as ForgeConfig['image_generation'],
    image_search: {
      provider: 'serpapi_lens',
      secret_key_name: 'serpapi-key',
      max_results: 5,
      confirm_upload: false,
      thumbnails: 4,
      timeout_ms: 60_000,
    },
    jobs: { enabled: true },
    agent_bus: { enabled: true },
    // `message_chat`'s gated actions are advertised text, so pricing the worst
    // case means pricing them: a window with `permissions.chats` on shows more
    // than one without, and the ceiling has to cover what a user can turn on.
    permissions: { chats: { new_chat: true, steer: true } },
    agent_links: { open_panel: 'every_ask', panel_live_timeout_ms: 20_000 },
    // `set_checkin` is registered only when this block exists, so pricing the
    // maximally-advertised set means pricing it with the block present.
    elapsed_time_note: { after_minutes: 30 },
  };
}

function makeMaximalRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const workspaceState = {
    get: () => undefined,
    update: async () => undefined,
  } as unknown as vscode.Memento;
  const secrets = { get: async () => undefined } as unknown as vscode.SecretStorage;
  const indexManager = { search: async () => [] } as unknown as IndexManager;
  const config = maximalConfig();
  const delegation = {
    ask: async () => ({ text: 'ok', targetModel: 'worker', bestEffort: false }),
  } as unknown as LocalDelegationService;
  const jobs = {
    store: { root: '/tmp/jobs' } as unknown as JobStore,
    hostFacade: () => undefined,
  };
  registerAllTools(
    registry,
    workspaceState,
    secrets,
    { provider: 'tavily', secret_key_name: 'audit-key' },
    indexManager,
    new UserQuestionService(),
    new UserNotificationService(),
    delegation,
    () => config,
    undefined,
    undefined,
    jobs,
    // The skills provider, so the maximally-advertised set prices `load_skill` in:
    // an unwired registry advertises it (nothing installed), which is exactly what
    // a config with skills enabled and no skill folders shows.
    {
      isEnabled: () => true,
      listCatalogEntries: () => [],
      loadSkillByName: async () => null,
    },
  );
  // load_tool_group advertises only once a lazy group is bridged in. Record one
  // so the maximally-advertised set includes it, matching a config that has
  // HalluScribe configured (the worst case for schema size).
  resetLazyToolGroups();
  recordLazyGroupTool('halluscribe', 'search_sessions');
  for (const name of registry.names()) recordNativeLazyTool(name);
  return registry;
}

function advertisedChars(registry: ToolRegistry): number {
  return JSON.stringify(
    registry
      .definitions(ALL_PERMISSIONS)
      .filter(
        (definition) =>
          !COMPUTER_USE_TOOLS_EXCLUDED_PENDING_DECISION.some((prefix) =>
            definition.function.name.startsWith(prefix),
          ),
      ),
  ).length;
}

describe('tool schema CI budget (TOOL_SCHEMA_GROWTH_PLAN.md Step 1)', () => {
  // Windows advertises the most (shell, the desktop tools), so the
  // worst case is measured as Windows whatever the CI host is.
  const realPlatform = process.platform;
  beforeEach(() =>
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }),
  );
  afterEach(() =>
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }),
  );

  it('advertises every registered tool under the maximal config', () => {
    const registry = makeMaximalRegistry();
    const names = registry
      .definitions(ALL_PERMISSIONS)
      .map((d) => d.function.name)
      .sort();
    expect(names).toHaveLength(registry.names().length);
    expect(names).toHaveLength(90);
    expect(names.filter((name) => name.startsWith('browser_'))).toHaveLength(15);
    expect(names.filter((name) => name.startsWith('desktop_'))).toHaveLength(9);
    // Spot-check the six self-suppressing tools that only appear when their
    // config block is present — these are the ones a bare config would drop.
    for (const name of [
      'generate_image',
      'image_search',
      'manage_jobs',
      'ask_agent',
      'upscale_image',
      'set_checkin',
    ]) {
      expect(names).toContain(name);
    }
  });

  // The purpose and member names together are ~519 estimated tokens for the
  // maximal registry; the ceiling catches unintended description growth.
  it('keeps load_tool_group discovery under 530 estimated tokens', () => {
    const registry = makeMaximalRegistry();
    const description = registry.get('load_tool_group')?.describe?.().function.description ?? '';
    // CI has no model tokenizer. Use the measured ~4.62 chars/token ratio
    // above, rounding up so this remains a conservative character gate.
    expect(Math.ceil(description.length / 4.62)).toBeLessThanOrEqual(530);
  });

  it('keeps the 65-tool non-computer-use schema under the character budget', () => {
    const registry = makeMaximalRegistry();
    const chars = advertisedChars(registry);
    expect({
      chars,
      budget: TOOL_SCHEMA_CHAR_BUDGET,
      measured: MEASURED_CHARS,
      message:
        chars > TOOL_SCHEMA_CHAR_BUDGET
          ? `Tool schema is ${chars} chars, over the ${TOOL_SCHEMA_CHAR_BUDGET}-char budget. ` +
            `Two sanctioned responses (TOOL_SCHEMA_GROWTH_PLAN.md): ` +
            `(1) merge the new tool into a family tool with an operation enum (Step 2), or ` +
            `(2) scope it by model/conversation so it is not advertised to every model (Step 3). ` +
            `Raising TOOL_SCHEMA_CHAR_BUDGET without one of those requires a note in CHANGES.md ` +
            `stating why.`
          : '',
    }).toMatchObject({ chars, budget: TOOL_SCHEMA_CHAR_BUDGET });
    expect(chars).toBeLessThanOrEqual(TOOL_SCHEMA_CHAR_BUDGET);
    // The recorded number is checked, not just reported. A `measured` that has
    // gone stale is how a half-finished edit in a shared worktree once read as a
    // flaky test: this line makes that impossible to miss.
    expect(chars).toBe(MEASURED_CHARS);
  });

  it('fails the budget when a new tool is registered (the gate actually bites)', () => {
    const registry = makeMaximalRegistry();
    // A dummy tool large enough to push the schema over the ceiling. The real
    // point is that the check is not a no-op: it must fail when the schema
    // grows, not just pass when it does not. Sized from the headroom, so a
    // raised ceiling cannot quietly outgrow a fixed-size canary.
    const headroom = TOOL_SCHEMA_CHAR_BUDGET - advertisedChars(registry);
    registry.register({
      definition: {
        type: 'function',
        function: {
          name: '_budget_canary',
          description: 'x'.repeat(headroom + 1_000),
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      permission: 'read',
      handler: async () => 'canary',
    });
    const chars = advertisedChars(registry);
    expect(chars).toBeGreaterThan(TOOL_SCHEMA_CHAR_BUDGET);
  });
});
