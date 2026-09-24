import type { ForgeConfig } from '../config/types';
import { githubReleaseCheck } from '../jobs/checks/github';
import { jobsFetch } from '../jobs/jobsFetch';
import { installLlamacppBuild } from '../jobs/actions/llamacppInstall';
import { extractZip, makeSetBinary, runCommand, sha256File } from '../jobs/actions/llamacppIo';
import { forgeLocalRoot } from '../jobs/actions/stagedBuild';
import type { RegisteredTool } from './ToolRegistry';

/**
 * `install_llamacpp`: the on-demand twin of the `llamacpp_update` job action.
 * Same pipeline (`installLlamacppBuild`: download, digest check, extract into
 * `%LOCALAPPDATA%\Forge\llama.cpp-<tag>\`, smoke test, zips deleted), then an
 * optional write of `llama_server.binary`. It never restarts the backend — the
 * model running this turn IS that backend — so the new build takes effect on
 * the next model load or `/restartBackend`.
 *
 * Exists because the agent's hand-rolled install (2026-09-21 session) took ~45
 * rounds: out-of-workspace mkdir/delete had no sanctioned tool, the staging
 * zips were left behind, and the procedure lived in a memory file it could not
 * read.
 */

const REPO = 'ggml-org/llama.cpp';
const DEFAULT_ASSET_PATTERN = 'llama-*-bin-win-cuda-*-x64.zip';

export interface LlamacppInstallDeps {
  getConfig: () => ForgeConfig;
  /** The config.yaml `switch_config` writes; undefined disables the switch. */
  configPath: string | undefined;
  /** Injectable for tests. */
  install?: typeof installLlamacppBuild;
  latestTag?: (allowedHosts: readonly string[]) => Promise<string>;
  localRoot?: () => string;
  setBinary?: (binary: string) => void;
}

/** The newest llama.cpp prerelease tag (the nightly `bNNNN` builds). */
async function latestPrereleaseTag(allowedHosts: readonly string[]): Promise<string> {
  const etagCache = new Map<string, string>();
  const result = await githubReleaseCheck(
    { kind: 'github_release', repo: REPO, channel: 'prerelease' },
    null,
    {
      fetch: (url) => jobsFetch(url, { allowedHosts, etagCache, forceFresh: true }),
      etagCache,
      allowedHosts,
    },
  );
  const tag = result.observation
    ? (JSON.parse(result.observation) as { tag?: unknown }).tag
    : undefined;
  if (typeof tag !== 'string') throw new Error(`Forge: no prerelease tag found for ${REPO}`);
  return tag;
}

export function makeInstallLlamacppTool(deps: LlamacppInstallDeps): RegisteredTool {
  const install = deps.install ?? installLlamacppBuild;
  const latestTag = deps.latestTag ?? latestPrereleaseTag;
  const localRoot = deps.localRoot ?? (() => forgeLocalRoot());
  const setBinary =
    deps.setBinary ?? (deps.configPath ? makeSetBinary(deps.configPath) : undefined);
  return {
    // Canonical literal: scripts/tool-audit-catalog.mjs extracts it statically.
    definition: {
      type: 'function',
      function: {
        name: 'install_llamacpp',
        description:
          'Install a llama.cpp Windows CUDA release in one call: downloads the zip and its cudart, verifies SHA-256, extracts to %LOCALAPPDATA%\\Forge\\llama.cpp-<tag>\\, smoke-tests llama-server, and by default points llama_server.binary at it. It does NOT restart the backend: the build takes effect on the next model load or /restartBackend.',
        parameters: {
          type: 'object',
          properties: {
            tag: {
              type: 'string',
              description:
                'Release tag such as "b11077". Omit for the newest prerelease (llama.cpp publishes its builds as prereleases).',
            },
            asset_pattern: {
              type: 'string',
              description:
                'File-name glob for the main zip. Omit for "llama-*-bin-win-cuda-*-x64.zip" (the newest CUDA build); the matching cudart zip is picked automatically.',
            },
            switch_config: {
              type: 'boolean',
              description:
                'Set llama_server.binary in config.yaml to the new build (comments preserved). Default true; false only installs.',
            },
          },
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    additionalPermissions: ['fetch'],
    mutation: { paths: () => (deps.configPath ? [deps.configPath] : []), showDiff: true },
    // Only on Windows (the only platform it installs for) and only for configs
    // that run llama.cpp at all: anyone else never pays this schema's prefill.
    advertise: () =>
      process.platform === 'win32' && deps.getConfig().llama_server?.binary !== undefined,
    approval: (args) => ({
      detail: `Install llama.cpp ${typeof args['tag'] === 'string' ? args['tag'] : '(newest prerelease)'} into ${localRoot()}${args['switch_config'] === false ? '' : ' and switch llama_server.binary'}`,
    }),
    handler: async (args) => {
      if (process.platform !== 'win32') {
        return 'Error: install_llamacpp installs Windows builds only. On this OS, install llama.cpp with the system package manager or build it from source.';
      }
      const config = deps.getConfig();
      const allowedHosts = config.jobs?.allowed_hosts ?? [];
      if (allowedHosts.length === 0) {
        return 'Error: jobs.allowed_hosts in config.yaml is empty, so Forge may not download anything. Ask the user to add api.github.com, github.com and release-assets.githubusercontent.com to it.';
      }
      const switchConfig = args['switch_config'] !== false;
      if (switchConfig && !setBinary) {
        return 'Error: Forge does not know which config.yaml to switch. Call again with switch_config: false and give the user the new binary path.';
      }
      const tag = typeof args['tag'] === 'string' ? args['tag'] : await latestTag(allowedHosts);
      const pattern =
        typeof args['asset_pattern'] === 'string' ? args['asset_pattern'] : DEFAULT_ASSET_PATTERN;
      const previous = config.llama_server?.binary;
      const installed = await install(REPO, tag, pattern, {
        localRoot: localRoot(),
        fetchOptions: () => ({ allowedHosts, etagCache: new Map<string, string>() }),
        getConfig: () => ({
          currentBinary: previous,
          embeddings: config.embeddings,
          llama_server: config.llama_server,
        }),
        runCommand,
        sha256File,
        extractZip,
      });
      const verified = installed.assets.map((a) => `${a.name} (${a.digest})`).join(', ');
      const lines = [
        `Installed llama.cpp ${tag}: ${installed.newBinary}`,
        `Verified and removed: ${verified}`,
        'Smoke test passed.',
      ];
      if (switchConfig && setBinary) {
        setBinary(installed.newBinary);
        lines.push(
          `llama_server.binary switched from ${previous ?? '(unset)'}. It takes effect on the next model load or /restartBackend — the backend was NOT restarted.`,
        );
      } else {
        lines.push('config.yaml was not changed.');
      }
      return lines.join('\n');
    },
  };
}
