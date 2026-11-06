/**
 * The skills service: the roots, the frozen catalog, and the reader behind
 * `load_skill` (plan §2.2–2.3, lane F2).
 *
 * One instance per activation, wired into the tool registry and into each
 * conversation's prompt. Everything it does is read-only: a skill grants
 * nothing, so there is no state here to write, no lease to hold and nothing to
 * cancel — the lifecycle question for this feature is "what does the model see,
 * and when does it change", which is why the interesting part is the freeze.
 *
 * The catalog is built once per conversation and stored on that conversation
 * (`ConversationRuntime.skillsCatalog`), together with the roots it was built
 * from. A skill added or removed mid-conversation therefore cannot rewrite a
 * running chat's prompt prefix — on Strata that would cost a cold re-read of the
 * whole conversation on every turn — while a new conversation, or a different
 * workspace folder, does see the change. That is the plan's "None; catalog
 * re-read at each new conversation" ledger cell, made exact.
 */
import * as os from 'os';
import type { ConversationRuntime } from '../sidebar/sessionTypes';
import type { ForgeConfig } from '../config/types';
import type { TemplateEngine } from '../llm/TemplateEngine';
import { discoverSkills, skillRoots, type SkillEntry, type SkillRoot } from './discover';
import { renderCatalog, SKILL_CATALOG_CHAR_CAP } from './catalog';
import { loadSkill, type LoadedSkill } from './loadSkill';

export interface SkillsServiceOptions {
  getConfig: () => ForgeConfig;
  /** Undefined is meaningful: no engine means the plain catalog rendering. */
  getTemplateEngine?: () => TemplateEngine | undefined;
  /** The extension install folder; its `resources/skills/` is the shipped root. */
  extensionPath: string;
  home?: string;
  getWorkspaceRoot: () => string;
  /** Defaults to the extension log; injectable so tests can count the lines. */
  log?: (message: string) => void;
}

interface DiscoveryCache {
  signature: string;
  entries: SkillEntry[];
  skipped: { name: string; root: string; reason: string }[];
}

/**
 * A conversation's frozen catalog, plus the roots it was frozen against.
 *
 * The signature is the roots and the enabled flag — never the contents of a
 * skill folder — because that is exactly the line between "this chat's catalog
 * stays frozen" and "a chat in a different workspace or with skills switched on
 * gets its own catalog".
 */
interface FrozenCatalog {
  signature: string;
  text: string;
}

export class SkillsService {
  private readonly home: string;
  private readonly log: (message: string) => void;
  private readonly loggedSkips = new Set<string>();

  constructor(private readonly options: SkillsServiceOptions) {
    this.home = options.home ?? os.homedir();
    this.log = options.log ?? (() => undefined);
  }

  /** Skills are on by default; only `skills.enabled: false` turns them off. */
  isEnabled(): boolean {
    return this.options.getConfig().skills?.enabled !== false;
  }

  /** The three roots, in the order later ones win. */
  roots(): SkillRoot[] {
    return skillRoots({
      extensionPath: this.options.extensionPath,
      home: this.home,
      ...(this.options.getWorkspaceRoot()
        ? { workspaceRoot: this.options.getWorkspaceRoot() }
        : {}),
    });
  }

  /**
   * The roots and the enabled flag, as one string. A change here means a
   * conversation's catalog is no longer the catalog for its roots, so it is
   * rebuilt; a change inside a root is not, and stays frozen for the chat.
   *
   * The workspace root is already in `roots()`, so it needs no extra line: a
   * workspace switch changes the `[workspace]` root and therefore this string.
   */
  private signature(): string {
    return [
      this.isEnabled() ? 'on' : 'off',
      ...this.roots().map((root) => `${root.kind}=${root.directory}`),
      `cap=${String(SKILL_CATALOG_CHAR_CAP)}`,
    ].join('\n');
  }

  /**
   * Discovery, read fresh from the roots. No memo: the freeze lives on the
   * conversation (`catalogFor` returns the stored text without walking the roots
   * again), so the only repeated walks are `load_skill` calls, and a skill the
   * owner installs between two of them must be loadable at once.
   */
  private discover(): DiscoveryCache {
    const discovered = discoverSkills(this.roots());
    return {
      signature: this.signature(),
      entries: discovered.skills,
      skipped: discovered.skipped.map((skip) => ({
        name: skip.name,
        root: skip.root,
        reason: skip.reason,
      })),
    };
  }

  /**
   * The catalog for one conversation: built on first use, then never rebuilt
   * while those roots stand. `undefined` means there is nothing to show — skills
   * off, or no skill anywhere — and the prompt gains no block at all.
   */
  catalogFor(conversation: ConversationRuntime | undefined): string | undefined {
    if (!this.isEnabled()) return undefined;
    const signature = this.signature();
    const frozen = conversation ? readFrozen(conversation, this.isEnabled()) : undefined;
    if (frozen && frozen.signature === signature) {
      return frozen.text || undefined;
    }
    const cache = this.discover();
    this.logSkips(cache);
    const engine = this.options.getTemplateEngine?.();
    const rendered = renderCatalog(engine, cache.entries);
    if (rendered.log) this.log(rendered.log);
    if (conversation) {
      conversation.skillsCatalog = rendered.text;
      conversation.skillsCatalogSignature = signature;
    }
    return rendered.text || undefined;
  }

  /**
   * The skills as they are right now — the list `load_skill` resolves against.
   *
   * Deliberately not the frozen catalog: a skill the owner installs mid-conversation
   * should be loadable at once, and the freeze is about what the model was *told*,
   * not about locking the folder. The unknown-name refusal lists this set, so the
   * model is never told a skill does not exist when it does.
   */
  listCatalogEntries(): SkillEntry[] {
    if (!this.isEnabled()) return [];
    return this.discover().entries;
  }

  /** Load one skill by name, or null when no root has that name. */
  async loadSkillByName(name: string): Promise<LoadedSkill | null> {
    if (!this.isEnabled()) return null;
    const entry = this.listCatalogEntries().find((candidate) => candidate.name === name);
    if (!entry) return null;
    return loadSkill(entry);
  }

  /**
   * Report each skipped skill once per root set, not once per turn.
   *
   * A broken skill is the owner's problem to fix, and the only way they learn of
   * it is this line; repeating it every turn would bury it, and saying nothing
   * would leave a skill that silently never appears.
   */
  private logSkips(cache: DiscoveryCache): void {
    for (const skip of cache.skipped) {
      const message = `Forge: skill "${skip.name}" in [${skip.root}] was skipped: ${skip.reason}`;
      if (this.loggedSkips.has(message)) continue;
      this.loggedSkips.add(message);
      this.log(message);
    }
  }

  dispose(): void {
    this.loggedSkips.clear();
  }
}

/**
 * Read a conversation's frozen catalog. The enabled flag is checked here rather
 * than left to the signature: `skills:` absent and `skills.enabled: true` share
 * one signature and both mean enabled. A stale marker left by an earlier enabled
 * run must still be dropped when the config has since turned skills off.
 */
function readFrozen(
  conversation: ConversationRuntime,
  enabled: boolean,
): FrozenCatalog | undefined {
  const stored = conversation.skillsCatalog;
  const signature = conversation.skillsCatalogSignature;
  if (typeof stored !== 'string' || typeof signature !== 'string') return undefined;
  if (!enabled && signature.split('\n')[0] === 'on') {
    delete conversation.skillsCatalog;
    delete conversation.skillsCatalogSignature;
    return undefined;
  }
  return { signature, text: stored };
}
