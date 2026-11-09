import * as vscode from 'vscode';
import type { RegisteredTool, ToolRegistry } from './ToolRegistry';
import type { SearchConfig, ForgeConfig } from '../config/types';
import type { LocalDelegationService } from '../delegation/LocalDelegationService';
import { makeLocalAgentTool, makeListDelegationTargetsTool } from './localAgentTool';
import {
  makeReadFileTool,
  makeWriteFileTool,
  makeReplaceSelectionTool,
  makeInsertCodeTool,
  makeGetEditorContextTool,
} from './builtinTools';
import { makeFindFilesTool } from './dirTools';
import { makeSearchCodeTool } from './searchCodeTool';
import { makeListDirectoryTool } from './listDirectoryTool';
import { makeCodeIntelTool } from './codeIntelTool';
import { makeApplyCodeActionTool } from './codeActionTools';
import { makeEditNotebookCellTool, makeReadNotebookTool } from './notebookTools';
import {
  makeShowDiffTool,
  makeOpenFileTool,
  makeNotifyUserTool,
  makeShowNotificationTool,
  makeCopyToClipboardTool,
  makeReadClipboardTool,
  makeOpenUrlTool,
} from './uxTools';
import { makeAskUserTool } from './askUserTool';
import { makeLoadSkillTool, type LoadSkillProvider } from './loadSkillTool';
import { PowerControl } from '../system/PowerControl';
import { makeGetPowerInfoTool, makeScheduleWakeTool, makeSleepComputerTool } from './powerTools';
import { makeWebFetchTool } from './fetchTool';
import { makeWebSearchTool } from './searchTool';
import {
  makeRememberTool,
  makeRecallTool,
  makeListMemoriesTool,
  makeForgetTool,
} from './memoryTools';
import { makeProblemWatcher } from './editDiagnostics';
import { makeEditFileTool } from './editFileTool';
import {
  makeMoveFileTool,
  makeDeleteFileTool,
  makeFormatFileTool,
  makeRenameSymbolTool,
} from './fileEditTools';
import { bundledRipgrepDir } from './RipgrepResolver';
import { makeShellTool } from './shellTool';
import { makeSystemStatusTool } from './systemStatusTool';
import type { BackendProcess } from '../system/SystemReport';
import { makeLoadToolGroupTool } from './toolGroupTools';
import type { MediaToolDeps } from './media/mediaToolDeps';
import { makeInstallLlamacppTool } from './llamacppInstallTool';
import { makeManageJobsTool } from './jobTools';
import { makeAskAgentTool } from './askAgentTool';
import type { StartAgentAsk } from '../agentLinks/pendingAgentAsks';
import { makeMessageChatTool, type MessageChatSidebar } from './messageChatTool';
import { makeReadToolResultTool } from './toolResultTools';
import { makeUpdatePlanTool } from './planTools';
import { makeGitReadTool } from './gitReadTool';
import {
  makeCreateBranchTool,
  makeSwitchBranchTool,
  makeStageTool,
  makeCommitTool,
  makeRestoreFileTool,
} from './gitTools';
import { makeSearchCodebaseTool } from './semanticSearchTool';
import type { IndexManager } from '../search/IndexManager';
import type { JobStore } from '../jobs/JobStore';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { makeApplyLineEditsTool } from './structuredEditTool';
import { applyOwnerOnlyWriteGuard, ownerOnlySetFor, type OwnerOnlySet } from './ownerPaths';
import { makeViewImageTool } from './imageTool';
import type { PdfPageRenderer } from './imageTool';
import { makeExportDocumentTool } from './exportDocumentTool';
import { makeSendFileTool } from './sendFileTool';
import { makeWaitTool } from './waitTool';
import { makeViewVideoTool } from './videoTool';
import { makeGenerateImageTool } from './imageGeneration/generateImageTool';
import { makeUpscaleImageTool, upscaleConfigFor } from './imageGeneration/upscaleImageTool';
import { makeSetCheckinTool } from './setCheckinTool';
import { makeRenderHtmlToImageTool } from './renderHtmlToImageTool';
import { makeGenerateMusicTool } from './media/generateMusicTool';
import { makeGenerateVideoTool } from './media/generateVideoTool';
import { SdServerRegistry } from '../backend/sdServerRegistry';
import type { MediaModelLifecycle } from './media/mediaGpuFreeing';
import { makeImageSearchTool } from './imageSearch/imageSearchTool';
import { makeBrowserTools } from './browser/browserTools';
import { makeDesktopTools } from './desktop/desktopTools';
import {
  makeListExecutionsTool,
  makeMonitorExecutionTool,
  makeStopExecutionTool,
} from './backgroundExecutionTools';

import type { UserQuestionService } from '../sidebar/UserQuestionService';
import { makeAllowCliAgents } from '../jobs/cliAgentGate';
import type { UserNotificationService } from '../sidebar/UserNotificationService';

export function registerAllTools(
  registry: ToolRegistry,
  workspaceState: vscode.Memento,
  secrets: vscode.SecretStorage,
  searchConfig: SearchConfig | undefined,
  indexManager: IndexManager,
  questions: UserQuestionService,
  notifications: UserNotificationService,
  delegationService?: LocalDelegationService,
  getConfig?: () => ForgeConfig,
  backendProcesses?: () => readonly BackendProcess[],
  resolveChatAttachment?: (relativePath: string) => string,
  jobs?: {
    store: JobStore;
    hostFacade: () => ForgeHostFacade | undefined;
    /** The active config.yaml: install_llamacpp's binary switch, and the
     *  owner-only guard below. Same value extension.ts passes to both. */
    configPath?: string;
  },
  onForgetMemory?: (key: string) => void,
  /** The sidebar, for `message_chat` and `ask_agent`'s background starter. */
  messageChatSidebar?: () => (MessageChatSidebar & { startAgentAsk: StartAgentAsk }) | undefined,
  /**
   * The skills service (`src/skills/skillsService.ts`): the roots, the frozen
   * catalog and the reader behind `load_skill`. Optional because the benchmark
   * tool host and the audit registry build a registry without one; unwired, the
   * tool still answers, and answers the same way a user with skills on and
   * nothing installed does — "no skills installed".
   */
  skills?: LoadSkillProvider,
  pdfPageRenderer?: PdfPageRenderer,
  /**
   * The shipped media renderers: the adapters folder inside this extension's
   * install, and the model-lifecycle seam (loaded models, busy state, the
   * control server's unload) the tools drive to free a GPU. Supplied by
   * `vscode/toolActivationSetup.ts`, which owns both the pool and the extension
   * path; absent, no media tool is registered at all.
   */
  mediaTools?: { adaptersDir: string; lifecycle: MediaModelLifecycle },
): SdServerRegistry | undefined {
  // config.yaml `extra_file_roots`: absolute folders outside the workspace that
  // delete_file and every file-writing tool may also reach. A getter, so a
  // config reload applies without re-registering the tools.
  const extraRoots = (): readonly string[] => getConfig?.().extra_file_roots ?? [];
  // `tools.file_length_warning`, read live for the same reason: a config edit
  // changes the threshold without re-registering the tools. Absent block = off,
  // so a workspace that never set it gets the results it always got.
  const lengthWarning = () => getConfig?.().tools?.file_length_warning;
  // `tools.edit_diagnostics`, read live for the same reason. ON when absent —
  // the one `tools:` block that is, because two seconds per edit was priced
  // against the 271 `tsc`/`eslint` shell rounds the note replaces (`
  // editDiagnostics.ts`). A host with no language services gets a no-op watcher
  // from the same call, so the benchmark tool host waits for nothing and appends
  // nothing. `enabled: false` restores the write results these tools produced
  // before 2026-10-29.
  const watchProblems = makeProblemWatcher({
    settings: () => getConfig?.().tools?.edit_diagnostics,
  });
  const secretDeps = getConfig ? { getConfig } : {};
  /**
   * The paths an agent may not change: the config file this window loaded, the
   * workspace's `.forge/config.yaml`, and everything under `~/.forge/`
   * (`ownerPaths.ts`, Lane A of `docs/plans/OWNER_GUARDS_PLAN.md` item 4). Every
   * file-mutating tool below is wrapped to refuse one, in every mode, before any
   * card. Read per call rather than once at registration, because a workspace
   * folder can appear after activation and a wrapped tool must not refuse a path
   * it was never shown.
   *
   * Deliberately NOT wrapped, each one checked: `install_llamacpp` switches one
   * field of this same file through `ConfigWriter` under its own approval card,
   * `manage_jobs` writes `~/.forge/jobs/<id>.json` as its own state, and the
   * image tools declare no paths. Refusing those would refuse a feature, not a
   * risk — the guard is about an agent rewriting the rules it is judged by.
   * The config path comes from `jobs.configPath`, the same value extension.ts
   * already threads to install_llamacpp. It matters only while the policy file is
   * absent: `ownerOnlySetFor` asks whether `~/.forge/policy.yaml` exists on every
   * call, from this closure, so the wall on `config.yaml` comes back the moment the
   * owner deletes that file and goes the moment it exists — with no window reload
   * and nothing cached between decisions.
   */
  const ownerOnly = (): OwnerOnlySet => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return ownerOnlySetFor({
      ...(jobs?.configPath ? { configPath: jobs.configPath } : {}),
      ...(root ? { workspaceRoot: root } : {}),
    });
  };
  const guarded = (tool: RegisteredTool): RegisteredTool =>
    applyOwnerOnlyWriteGuard(tool, ownerOnly);
  // v0.1 builtins
  registry.register(makeReadFileTool(secretDeps));
  registry.register(makeViewImageTool(getConfig, pdfPageRenderer));
  // Registered unconditionally, unlike generate_image: send_file reads a file
  // and delivers it, so it needs no config block to exist — the same reasoning
  // as view_image two lines up. Gating it on getConfig would silently drop the
  // tool wherever that getter is not supplied. `notifications` is a required
  // argument of this signature, so the delivery dependency is always present.
  registry.register(makeSendFileTool({ ...(getConfig ? { getConfig } : {}), notifications }));
  // Registered unconditionally, beside send_file: it needs no config block to
  // exist. `browser.channel` is read to locate the binary and falls back to
  // 'chrome', and a missing binary errors at call time naming the fix. It is
  // deliberately NOT gated by permissions.browser.enabled -- that gate is for
  // interactive browsing, and this is a render engine (headless, JS disabled,
  // network blocked, per-call). See docs/plans/SEND_FILE_AND_RENDER_HTML_PLAN.md.
  registry.register(
    makeRenderHtmlToImageTool({
      ...(getConfig ? { getConfig } : {}),
      notifications,
    }),
  );
  // Registered unconditionally: getConfig is optional on this signature, and
  // gating on it would silently drop the tool wherever it is not supplied.
  registry.register(makeViewVideoTool(getConfig ? () => getConfig().video : undefined));
  registry.register(guarded(makeWriteFileTool(extraRoots, lengthWarning, watchProblems)));
  registry.register(guarded(makeReplaceSelectionTool()));
  registry.register(guarded(makeInsertCodeTool()));
  registry.register(makeGetEditorContextTool());

  // v0.5 read-only
  registry.register(makeListDirectoryTool());
  registry.register(makeFindFilesTool());
  registry.register(makeSearchCodeTool(undefined, secretDeps));
  registry.register(makeReadToolResultTool());
  registry.register(makeUpdatePlanTool());
  registry.register(makeSearchCodebaseTool(indexManager));
  registry.register(makeCodeIntelTool());
  registry.register(makeReadNotebookTool());
  registry.register(makeShowDiffTool());
  registry.register(makeOpenFileTool());
  registry.register(makeAskUserTool(questions));
  // Skills: eager and ungrouped, beside `ask_user` (`lazyToolGroups.ts`'s
  // membership map deliberately has no entry for it). A skill the model cannot
  // see cannot be asked for, and its catalog line is already in the prompt, so
  // holding this tool back would make half the catalog unreachable for a
  // `load_tool_group` round. Ungrouped means the schema is on every turn when
  // skills are on -- which is why `skills.enabled: false` opts out of the schema.
  registry.register(
    makeLoadSkillTool(
      skills ?? {
        isEnabled: () => true,
        listCatalogEntries: () => [],
        loadSkillByName: async () => null,
      },
    ),
  );
  registry.register(makeNotifyUserTool(notifications));

  // Power control. One PowerControl instance for all three: it is stateless,
  // and a second one would be a second owner of the same spawn sites.
  const power = new PowerControl();
  registry.register(makeGetPowerInfoTool(power));
  registry.register(makeScheduleWakeTool(power));
  registry.register(makeSleepComputerTool(power));
  registry.register(makeWaitTool());
  registry.register(makeShowNotificationTool());
  registry.register(makeCopyToClipboardTool());
  registry.register(makeReadClipboardTool());
  registry.register(makeOpenUrlTool({ ...(getConfig ? { getConfig } : {}), extraRoots }));
  registry.register(makeWebFetchTool(getConfig ? { getConfig } : {}));
  registry.register(makeRememberTool(workspaceState));
  registry.register(makeRecallTool(workspaceState));
  registry.register(makeListMemoriesTool(workspaceState));
  registry.register(makeForgetTool(workspaceState, onForgetMemory));
  if (searchConfig) {
    registry.register(makeWebSearchTool(secrets, searchConfig));
  }

  // v0.6 write tools
  registry.register(
    guarded(
      makeExportDocumentTool({
        ...(getConfig ? { getConfig } : {}),
        extraRoots,
        clankerMode: (conversationId) =>
          messageChatSidebar?.()?.getHostFacade().clankerMode(conversationId) ?? false,
      }),
    ),
  );
  registry.register(guarded(makeEditFileTool(extraRoots, lengthWarning, watchProblems)));
  registry.register(guarded(makeApplyLineEditsTool(extraRoots, lengthWarning, watchProblems)));
  registry.register(guarded(makeMoveFileTool(extraRoots)));
  registry.register(guarded(makeDeleteFileTool(extraRoots)));
  registry.register(guarded(makeFormatFileTool(extraRoots)));
  registry.register(guarded(makeRenameSymbolTool(extraRoots)));
  registry.register(guarded(makeApplyCodeActionTool(extraRoots)));
  registry.register(guarded(makeEditNotebookCellTool()));

  // v0.7 exec + git
  registry.register(
    makeShellTool({
      ...(getConfig ? { getConfig } : {}),
      clankerMode: (conversationId) =>
        messageChatSidebar?.()?.getHostFacade().clankerMode(conversationId) ?? false,
      ripgrepDir: () => bundledRipgrepDir(vscode.env.appRoot),
      // The shell route onto the same paths: `Add-Content .forge/config.yaml`,
      // `echo x > .forge/config.yaml`, `cp`, `mv`, `rm`. Refused as a `refused`
      // classification, so `autoApproveIf` answers it and no card is raised in
      // any mode, and the handler throws the rule's own text.
      ownerOnly: () => ownerOnly().roots,
    }),
  );
  registry.register(makeMonitorExecutionTool());
  registry.register(makeStopExecutionTool());
  registry.register(makeListExecutionsTool());
  registry.register(makeSystemStatusTool(backendProcesses ? { backendProcesses } : {}));
  registry.register(makeGitReadTool(secretDeps));
  registry.register(makeCreateBranchTool());
  registry.register(makeSwitchBranchTool());
  registry.register(makeStageTool());
  registry.register(makeCommitTool());
  registry.register(guarded(makeRestoreFileTool()));

  // delegation — only registered when a LocalDelegationService is wired in
  if (delegationService && getConfig) {
    registry.register(makeLocalAgentTool(delegationService, getConfig));
    registry.register(makeListDelegationTargetsTool(getConfig));
  }

  // Self-suppressing until config.yaml has an image_generation block, so a
  // config without one keeps the tool list -- and the KV prefix -- unchanged.
  //
  // The `sd-server` children are built here, beside the tool that dispatches to
  // them, and returned: `registerAllTools` is called once per activation and the
  // tool reads the live config through `getConfig`, so a config reload never
  // re-registers the tool. The registry is what makes ledger row 1 true -- the
  // caller disposes it on deactivate and calls `applyForgeConfig` on reload, so
  // removing or editing an `sdcpp` backend stops its process instead of leaking
  // a server that holds VRAM forever.
  let sdServers: SdServerRegistry | undefined;
  if (getConfig) {
    sdServers = new SdServerRegistry(getConfig());
    registry.register(
      makeGenerateImageTool({
        getConfig,
        secrets,
        notifications,
        sdServers: () => sdServers?.handles() ?? new Map(),
      }),
    );
    // Same self-suppression, keyed on an image_search block.
    registry.register(
      makeImageSearchTool({
        getConfig,
        secrets,
        notifications,
        ...(resolveChatAttachment ? { resolveAttachment: resolveChatAttachment } : {}),
      }),
    );
    // Registered ONLY when `image_generation.upscale` is configured — not merely
    // self-suppressing — because one more tool is a schema on every turn and a
    // cold re-prefill when the list changes (plan §4c "Tool budget"). A config
    // without the block never sees its tokens. The tool also carries an
    // `advertise` predicate: `registerAllTools` runs once per activation, so
    // that is what suppresses it after the owner deletes the block and reloads
    // config.yaml without reloading the window.
    if (upscaleConfigFor(getConfig())) {
      registry.register(makeUpscaleImageTool({ getConfig, notifications }));
    }
  }

  // Persistent agent jobs (B2). Self-suppressing until a `jobs:` block is
  // present, so a config without one keeps the tool list unchanged. The tool
  // needs `getConfig` for its advertise predicate, so it is registered only
  // when both the jobs wiring and a config getter are supplied.
  if (jobs && getConfig) {
    registry.register(
      makeManageJobsTool({
        store: jobs.store,
        getConfig,
        ...(jobs.hostFacade ? { hostFacade: jobs.hostFacade } : {}),
        ...(jobs.configPath ? { allowCliAgents: makeAllowCliAgents(jobs.configPath) } : {}),
      }),
    );
  }

  // On-demand llama.cpp install: the jobs action's pipeline without a job.
  if (getConfig) {
    registry.register(makeInstallLlamacppTool({ getConfig, configPath: jobs?.configPath }));
  }

  // Agent messaging. Self-suppressing until `agent_bus.enabled`, so a config
  // without it keeps the tool list unchanged.
  registry.register(
    makeMessageChatTool({
      getSidebar: messageChatSidebar ?? (() => undefined),
      ...(getConfig ? { getConfig } : {}),
    }),
  );
  if (getConfig) {
    registry.register(
      makeAskAgentTool({
        getConfig,
        getStarter: () => messageChatSidebar?.()?.startAgentAsk,
      }),
    );
  }

  // The model's own check-in timer. Always registered; its `advertise` predicate
  // reads the live config, so the tool is offered only while the
  // `elapsed_time_note` block exists and a config without it never pays the
  // schema. Registering only when the block existed at activation meant adding
  // the block later did nothing until a window reload (2026-10-13 A/B run).
  if (getConfig) {
    registry.register(makeSetCheckinTool({ getConfig }));
  }

  // Browser tools (plan §4.2): registered when a config getter exists; the
  // `browser` permission (deny-by-default) filters advertisement and dispatch, so
  // a config without `permissions.browser.enabled` advertises none of them and
  // the native prefix stays byte-identical for existing users.
  if (getConfig) {
    for (const tool of makeBrowserTools(getConfig)) registry.register(tool);
    // Desktop tools (plan §4.2): same pattern; `desktop` permission +
    // `advertise: isWin` (B7) filter advertisement and dispatch.
    for (const tool of makeDesktopTools(getConfig)) registry.register(tool);
  }

  // The shipped media renderers (docs/plans/MEDIA_SHIPPED_PLAN.md §1). Registered
  // ONLY while `media.enabled` is true: a config without media pays no schema,
  // and each tool also carries an `advertise` predicate so turning media off in
  // a reloaded config hides it without a window reload. They are appended after
  // the image tools and before `load_tool_group`, keeping the native prefix
  // byte-identical for existing users.
  if (mediaTools && getConfig) {
    const mediaDeps: MediaToolDeps = {
      getConfig,
      adaptersDir: mediaTools.adaptersDir,
      lifecycle: mediaTools.lifecycle,
      deliverMediaFile: async (event) => {
        const result = await notifications.deliverFile({
          conversationId: event.conversationId,
          text: event.text,
          mediaFile: {
            kind: event.kind,
            workspacePath: event.workspacePath,
            ...(event.previewPath ? { previewPath: event.previewPath } : {}),
          },
        });
        return result.kind === 'queued' ? result.chats : 0;
      },
      // A staged run that dies before its render stage has no completion notice
      // to carry its failure, so it says so through the same text path (BL-033).
      notifyChainFailure: async (event) => {
        await notifications.notify({
          conversationId: event.conversationId,
          text:
            `Forge: media run ${event.runId} did not finish — ${event.reason}. ` +
            `Run folder: ${event.runDir}.`,
        });
      },
      ...(getConfig().image_generation
        ? { sdServers: () => sdServers?.handles() ?? new Map() }
        : {}),
    };
    if (getConfig().media?.enabled) {
      registry.register(makeGenerateVideoTool(mediaDeps));
      registry.register(makeGenerateMusicTool(mediaDeps));
    }
  }

  // Registered last, and self-suppressing until a lazy group is actually
  // bridged in: definitions() follows insertion order, so appending here
  // leaves the native prefix above byte-identical for the KV cache.
  registry.register(makeLoadToolGroupTool());
  return sdServers;
}
