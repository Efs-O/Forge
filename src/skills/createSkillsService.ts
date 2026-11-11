/**
 * Building the skills service for an activation.
 *
 * Split from `extension.ts` for the same reason `statusBarTurnEvents.ts` was:
 * `extension.ts` is at this repo's 500-line gate, and the four getters the
 * service needs (install folder, live config, live template engine, current
 * workspace folder) are the whole of its wiring. The service reads them per call
 * rather than capturing them, so a `config.yaml` reload or a workspace-folder
 * switch takes effect without re-registering `load_skill` — the
 * `set_checkin` lesson recorded in `registerAllTools.ts`.
 *
 * This file owns the log line. `SkillsService` itself takes an injected logger so
 * its tests can count the lines it writes (a broken skill is reported once per
 * root set, and that is the only way an owner learns a skill never appeared).
 */
import { getLogger } from '../util/logger';
import type { ForgeConfig } from '../config/types';
import type { TemplateEngine } from '../llm/TemplateEngine';
import { SkillsService } from './skillsService';

export interface SkillsServiceWiring {
  extensionPath: string;
  getConfig: () => ForgeConfig;
  getTemplateEngine: () => TemplateEngine | undefined;
  getWorkspaceRoot: () => string;
  /** Defaults to the extension log; injectable for tests. */
  log?: (message: string) => void;
}

export function createSkillsService(wiring: SkillsServiceWiring): SkillsService {
  return new SkillsService({
    extensionPath: wiring.extensionPath,
    getConfig: wiring.getConfig,
    getTemplateEngine: wiring.getTemplateEngine,
    getWorkspaceRoot: wiring.getWorkspaceRoot,
    log: wiring.log ?? ((message: string) => getLogger().warn(message)),
  });
}
