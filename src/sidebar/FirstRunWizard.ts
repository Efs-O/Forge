/**
 * The fallback first-run wizard: the setup path for someone with no coding
 * agent installed, who therefore cannot run the `AI_SETUP.md` walkthrough.
 *
 * It gets one local model running and asks the same trust-switch questions
 * Step 0 asks, so a wizard user can turn a switch on without editing YAML:
 * one pick over every GGUF and Ollama model it can find, then (for a GGUF)
 * which `llama-server` to run, then the questions, then a check of the file it
 * wrote and the engine it configured before the reload is offered.
 *
 * The config always goes to Forge's global storage — the file `bootstrapConfig`
 * reads at activation (`src/extension.ts`), so one setup works in every folder.
 * Someone who wants a workspace config instead sets `forge.configFile`
 * themselves; the wizard no longer asks, because a workspace config is the one
 * thing a first run cannot get wrong on its own.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { extractQuant, scanForGgufs, type GgufCandidate } from '../backend/GgufScanner';
import { deriveModelSuggestion } from '../backend/ModelHeuristics';
import {
  makeLlamaCppStarterConfig,
  makeOllamaStarterConfig,
  withCliAgents,
  type FoundCliAgents,
} from '../config/StarterConfig';
import { writeConfigSafely } from '../config/ConfigWriter';
import { loadConfig } from '../config/ConfigLoader';
import { runCommand } from '../jobs/actions/llamacppIo';
import { applyTrustPicks, wizardSwitchQuestions } from '../config/trustSwitches';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import type { ForgeConfig } from '../config/types';

const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const LLAMA_CPP_RELEASES_URL = 'https://github.com/ggml-org/llama.cpp/releases';

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ── The coding agents on PATH ─────────────────────────────────────────────────

/** True when the CLI resolves on PATH. A miss is an answer here, not an error:
 *  the wizard only decides whether to add the entry. */
async function onPath(name: 'claude' | 'codex'): Promise<boolean> {
  return resolveCliExecutable(name, name).then(
    () => true,
    () => false,
  );
}

async function findCliAgents(): Promise<FoundCliAgents> {
  const [claude, codex] = await Promise.all([onPath('claude'), onPath('codex')]);
  return { claude, codex };
}

/** One line for the reload toast: what was added, or how to add it later. */
function describeCliAgents(found: FoundCliAgents): string {
  const added = [found.claude && 'Claude Code', found.codex && 'Codex'].filter(Boolean);
  if (added.length) {
    return ` Added ${added.join(' and ')} (found on PATH) — log in to each CLI yourself; Forge holds no keys.`;
  }
  return (
    ' Claude Code / Codex were not found on PATH — install and log in, then add ' +
    '`{ name: claude-code, provider: cli, cli: claude }` to models (same for codex).'
  );
}

// ── One pick, every model source ──────────────────────────────────────────────

export type WizardModelPick =
  | { kind: 'gguf'; candidate: GgufCandidate }
  | { kind: 'ollama'; tag: string }
  | { kind: 'browse-gguf' }
  | { kind: 'type-ollama' };

type ModelPickItem = { label: string; description: string; pick: WizardModelPick };

/**
 * The whole model list as data: the GGUFs the scan found (largest first, as
 * `GgufScanner` sorts them), then the tags Ollama reports, then the two ways in
 * for a model neither source could see. The last two are always offered — a
 * model in a folder Forge never guesses, or an Ollama tag on another machine,
 * are the common cases, and neither is a dead end.
 */
export function modelPickItems(
  ggufs: readonly GgufCandidate[],
  ollamaTags: readonly string[],
): ModelPickItem[] {
  return [
    ...ggufs.slice(0, 10).map(
      (candidate): ModelPickItem => ({
        label: candidate.modelName,
        description: `${(candidate.sizeBytes / 1e9).toFixed(1)} GB · llama.cpp · ${candidate.familyHint}`,
        pick: { kind: 'gguf', candidate },
      }),
    ),
    ...ollamaTags.map(
      (tag): ModelPickItem => ({
        label: tag,
        description: 'Ollama',
        pick: { kind: 'ollama', tag },
      }),
    ),
    {
      label: 'Browse for a GGUF file…',
      description: 'llama.cpp',
      pick: { kind: 'browse-gguf' },
    },
    {
      label: 'Type an Ollama model name…',
      description: 'Ollama',
      pick: { kind: 'type-ollama' },
    },
  ];
}

/** Both sources at once, so the user answers one list instead of two screens.
 *  A source that is not running answers with nothing, not with an error. */
async function scanForModels(): Promise<{
  ggufs: GgufCandidate[];
  ollamaTags: string[];
}> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Forge: Looking for models…',
    },
    async () => {
      const [ggufs, ollamaTags] = await Promise.all([
        scanForGgufs(),
        fetchOllamaModels(OLLAMA_ENDPOINT).catch(() => [] as string[]),
      ]);
      return { ggufs, ollamaTags };
    },
  );
}

async function pickModel(): Promise<WizardModelPick | undefined> {
  const { ggufs, ollamaTags } = await scanForModels();
  const picked = await vscode.window.showQuickPick(modelPickItems(ggufs, ollamaTags), {
    title: 'Forge: Pick a model to start with',
    placeHolder: 'Pick a model, or add one Forge did not find',
    ignoreFocusOut: true,
  });
  return picked?.pick;
}

export async function fetchOllamaModels(endpoint: string): Promise<string[]> {
  const base = endpoint.replace(/\/$/, '').replace(/\/(v1|api)$/, '');
  const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return [];
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name).filter(Boolean);
}

/** A GGUF the scan did not see: the same fields the scanner fills, read off the
 *  file itself. `familyHint` is unknown because nothing read the file's
 *  metadata; the sampling the config gets comes from `deriveModelSuggestion`. */
function candidateFromPath(ggufPath: string): GgufCandidate {
  const name = path.basename(ggufPath);
  const quant = extractQuant(name);
  return {
    ggufPath,
    modelName: path.basename(ggufPath, path.extname(ggufPath)),
    sizeBytes: fs.statSync(ggufPath).size,
    familyHint: 'unknown',
    ...(quant !== undefined ? { quant } : {}),
  };
}

/** What the user chose, with everything the config and the check need. */
type WizardSelection =
  | { kind: 'llamacpp'; candidate: GgufCandidate; binary: string }
  | { kind: 'ollama'; tag: string };

/** Turn the pick into a model, and for a GGUF the binary to run it with.
 *  `undefined` means the user stopped the wizard. */
async function resolveSelection(pick: WizardModelPick): Promise<WizardSelection | undefined> {
  if (pick.kind === 'ollama') return { kind: 'ollama', tag: pick.tag };
  if (pick.kind === 'type-ollama') {
    const typed = await vscode.window.showInputBox({
      title: 'Forge: Ollama model name',
      prompt: 'Enter exact model tag (e.g. gemma4:e4b)',
      placeHolder: 'gemma4:e4b',
      ignoreFocusOut: true,
    });
    const tag = typed?.trim();
    return tag ? { kind: 'ollama', tag } : undefined;
  }

  let candidate: GgufCandidate;
  if (pick.kind === 'gguf') {
    candidate = pick.candidate;
  } else {
    const chosen = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { GGUF: ['gguf'] },
    });
    const ggufPath = chosen?.[0]?.fsPath;
    if (!ggufPath) return undefined;
    candidate = candidateFromPath(ggufPath);
  }
  const binary = await pickLlamaServer();
  return binary ? { kind: 'llamacpp', candidate, binary } : undefined;
}

// ── Which llama-server to run ─────────────────────────────────────────────────

type ServerItem =
  | { label: string; choice: 'use'; serverPath: string }
  | { label: string; choice: 'browse' }
  | { label: string; choice: 'download' };

/**
 * Where `llama-server` lives. The PATH the registry holds right now is searched
 * first, so an install made since VS Code started is found. The chosen path is
 * written as the binary, never the bare name: this is the one place the file
 * was actually seen, and a starter that names a file rather than a lookup has
 * no PATH to get wrong after a reload.
 */
async function pickLlamaServer(): Promise<string | undefined> {
  const resolved = await resolveCliExecutable('llama-server', 'llama-server').catch(
    () => undefined,
  );
  return askForServer(resolved);
}

/** The pick itself, shown again after the release page opens: the download
 *  lands wherever the user put it, so browsing to it is the only way to finish
 *  without restarting the wizard. */
async function askForServer(resolved: string | undefined): Promise<string | undefined> {
  const items: ServerItem[] = [
    ...(resolved
      ? [{ label: `Use ${resolved}`, choice: 'use' as const, serverPath: resolved }]
      : []),
    { label: 'Browse for llama-server…', choice: 'browse' as const },
    { label: 'Get llama.cpp (opens the official release page)', choice: 'download' as const },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Forge: Which llama-server should Forge run?',
    placeHolder: resolved
      ? 'Use the llama-server on PATH, browse for another, or get llama.cpp'
      : 'No llama-server on PATH — browse for it, or get llama.cpp',
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  if (picked.choice === 'use') return picked.serverPath;
  if (picked.choice === 'browse') {
    const chosen = await vscode.window.showOpenDialog({ canSelectMany: false });
    return chosen?.[0]?.fsPath;
  }
  // The page opens and the same pick comes back, so the file the user just
  // downloaded can be browsed to.
  await vscode.env.openExternal(vscode.Uri.parse(LLAMA_CPP_RELEASES_URL));
  return askForServer(resolved);
}

// ── The trust switches, in Step 0's words ─────────────────────────────────────

/**
 * One multi-select per Step 0 question. Escape on a question is "none of
 * these", not a cancelled wizard: a user who wants nothing turned on gets
 * exactly that and still finishes.
 */
async function askTrustSwitches(found: FoundCliAgents): Promise<string[]> {
  const pickedIds: string[] = [];
  for (const group of wizardSwitchQuestions(found)) {
    const items = group.switches.map((switch_) => ({
      label: switch_.label,
      detail: switch_.description,
      id: switch_.id,
      // Step 0 marks both file actions "(Recommended)", so they start picked.
      ...(group.question === 5 ? { picked: true } : {}),
    }));
    const chosen = await vscode.window.showQuickPick(items, {
      title: `Forge: ${group.title}`,
      placeHolder: 'Pick any that apply — Escape means none of these',
      canPickMany: true,
      ignoreFocusOut: true,
    });
    for (const item of chosen ?? []) pickedIds.push(item.id);
  }
  return pickedIds;
}

// ── Where the config goes ─────────────────────────────────────────────────────

/** Forge's global storage, always: the path `bootstrapConfig` already reads. */
async function confirmConfigPath(context: vscode.ExtensionContext): Promise<string | undefined> {
  const configPath = path.join(context.globalStorageUri.fsPath, 'config.yaml');
  if (!fs.existsSync(configPath)) return configPath;
  const replace = await vscode.window.showWarningMessage(
    `Forge: ${configPath} already exists. Replace it? A .bak backup will be created.`,
    { modal: true },
    'Replace config',
  );
  return replace === 'Replace config' ? configPath : undefined;
}

// ── The check that runs before the reload ─────────────────────────────────────

type HealthOutcome =
  | { ok: true; checks: string[] }
  | { ok: false; failedStep: string; reason: string };

const healthFail = (failedStep: string, reason: string): HealthOutcome => ({
  ok: false,
  failedStep,
  reason,
});

/**
 * Ask the machine, in order, whether it can do what the new config says, and
 * stop at the first thing that cannot answer: a config that does not load makes
 * the rest moot, and a `llama-server` that does not run will never serve a
 * chat. Each pass is named in the user's words, so the toast is readable
 * without opening a file.
 */
async function checkSetup(configPath: string, selection: WizardSelection): Promise<HealthOutcome> {
  const checks: string[] = [];
  try {
    loadConfig(path.dirname(configPath));
  } catch (error) {
    return healthFail('config check', errorText(error));
  }
  checks.push('config valid');

  if (selection.kind === 'ollama') {
    let tags: string[];
    try {
      tags = await fetchOllamaModels(OLLAMA_ENDPOINT);
    } catch (error) {
      return healthFail('Ollama check', errorText(error));
    }
    if (!tags.includes(selection.tag)) {
      return healthFail('Ollama check', `${selection.tag} is not in Ollama's model list`);
    }
    checks.push(`Ollama has ${selection.tag}`);
    return { ok: true, checks };
  }

  let result;
  try {
    result = await runCommand(selection.binary, ['--version'], 15_000);
  } catch (error) {
    return healthFail('llama-server check', errorText(error));
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    return healthFail('llama-server check', detail.slice(0, 200));
  }
  checks.push('llama-server answers --version');
  return { ok: true, checks };
}

async function reportOutcome(
  configPath: string,
  outcome: HealthOutcome,
  cliAgentNote: string,
): Promise<void> {
  if (outcome.ok) {
    const choice = await vscode.window.showInformationMessage(
      `Forge: setup check passed: ${outcome.checks.join(', ')}.${cliAgentNote} Reload the window to start.`,
      'Reload',
    );
    if (choice === 'Reload') void vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Forge: config written to ${configPath}, but ${outcome.failedStep} failed: ${outcome.reason}`,
    'Reload anyway',
    'Open config',
  );
  if (choice === 'Reload anyway') {
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
  if (choice === 'Open config') {
    void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(configPath));
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

function llamaCppStarter(candidate: GgufCandidate, binary: string): ForgeConfig {
  const suggestion = deriveModelSuggestion(candidate);
  return makeLlamaCppStarterConfig(
    [{ ggufPath: candidate.ggufPath, modelName: suggestion.suggestedName, suggestion }],
    binary,
  );
}

/**
 * The fallback setup for a user with no coding agent: find a model, pick the
 * engine, ask the trust questions, write a validated starter `config.yaml` to
 * Forge's global storage and check it before offering the reload. Someone who
 * wants a workspace config sets `forge.configFile` themselves.
 * Returns true if a config was written, false if the user cancelled.
 */
export async function runFirstRunWizard(context: vscode.ExtensionContext): Promise<boolean> {
  const pick = await pickModel();
  if (!pick) return false;
  const selection = await resolveSelection(pick);
  if (!selection) return false;

  const found = await findCliAgents();
  const pickedIds = await askTrustSwitches(found);

  const configPath = await confirmConfigPath(context);
  if (!configPath) return false;

  const starter: ForgeConfig =
    selection.kind === 'ollama'
      ? makeOllamaStarterConfig(OLLAMA_ENDPOINT, [selection.tag])
      : llamaCppStarter(selection.candidate, selection.binary);
  writeConfigSafely(configPath, applyTrustPicks(withCliAgents(starter, found), pickedIds));
  await context.globalState.update('forge.firstRun.shown', true);

  await reportOutcome(
    configPath,
    await checkSetup(configPath, selection),
    describeCliAgents(found),
  );
  return true;
}
