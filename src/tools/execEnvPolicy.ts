/**
 * Validation for the `env` parameter of `exec_command`.
 *
 * This module is deliberately pure — no `vscode` import — so it is unit-testable
 * outside the extension host, for the same reason `processSpawn.ts` lives in
 * `src/util` rather than `tools/execHelpers.ts`. One concern per module, matching
 * `DenyList.ts` and `execProgramResolver.ts`.
 *
 * The threat model. `exec_command` spawns with `shell: false`, so an env VALUE is
 * never shell-parsed: `; rm -rf /` as a value is inert to the shell. The real risk
 * is an env NAME the program's own runtime reads to load code or redirect
 * behaviour — `NODE_OPTIONS` (`--require` = arbitrary code), `LD_PRELOAD`,
 * `PYTHONPATH`, `npm_execpath`, … That set is closed and nameable, so the policy
 * is a DENYLIST of dangerous names (plus key-shape and size caps). The
 * load-bearing boundary is still `shell: false`; this denylist is
 * defense-in-depth on top of it. A newly discovered dangerous name is a one-line
 * addition, not a redesign.
 */

export interface ExecEnvResult {
  ok: boolean;
  env: Record<string, string>;
  error?: string;
}

export const MAX_ENV_VARS = 32;
export const MAX_ENV_VALUE_LENGTH = 8192;

/**
 * Standard env-var name shape. Also rejects any key containing spaces or shell
 * metacharacters. Windows allows exotic names, but a model-facing tool does not
 * need them.
 */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Lowercased. Rationale per name in the plan (§4.1).
 */
const BLOCKED_ENV_NAMES = new Set<string>([
  // Node / Electron runtime injection (highest risk)
  'node_options',
  'node_path',
  'node_extra_ca_certs',
  'node_tls_reject_unauthorized',
  'node_compile_cache',
  // Dynamic-loader / interpreter startup hooks (cross-language)
  'ld_preload',
  'ld_library_path',
  'ld_audit',
  'ld_debug',
  'pythonstartup',
  'pythonpath',
  'pythonhome',
  'java_tool_options',
  '_java_options',
  'classpath',
  'jdk_java_options',
  'dotnet_startup_hooks',
  'dotnet_additional_deps',
  'rubyopt',
  'perl5lib',
  'perllib',
  'perl5opt',
  'bash_env',
  'env',
  // Identity / config redirection
  'path',
  'pathext',
  'comspec',
  'home',
  'userprofile',
  'appdata',
  'localappdata',
  'tmp',
  'tmpdir',
  'temp',
  'git_dir',
  'git_work_tree',
  'npm_execpath',
]);

/**
 * Prefixes are matched separately: `npm_config_*`, `npm_lifecycle_*`,
 * `git_config_*` (npm/git behaviour redirection) and `dyld_*` (macOS dynamic
 * loader — covers DYLD_INSERT_LIBRARIES, DYLD_LIBRARY_PATH, and any DYLD_*).
 */
const BLOCKED_ENV_PREFIXES = ['npm_config_', 'npm_lifecycle_', 'git_config_', 'dyld_'];

export function validateExecEnv(
  raw: Record<string, unknown> | undefined,
): ExecEnvResult {
  if (raw === undefined) return { ok: true, env: {} };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, env: {}, error: 'env must be an object of string values' };
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_ENV_VARS) {
    return {
      ok: false,
      env: {},
      error: `env has ${entries.length} vars; max is ${MAX_ENV_VARS}`,
    };
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!ENV_KEY_PATTERN.test(key)) {
      return { ok: false, env: {}, error: `env key "${key}" is not a valid variable name` };
    }
    const lower = key.toLowerCase();
    if (BLOCKED_ENV_NAMES.has(lower)) {
      return {
        ok: false,
        env: {},
        error: `env key "${key}" is not allowed for exec_command`,
      };
    }
    if (BLOCKED_ENV_PREFIXES.some((p) => lower.startsWith(p))) {
      return {
        ok: false,
        env: {},
        error: `env key "${key}" is not allowed for exec_command`,
      };
    }
    if (typeof value !== 'string') {
      return { ok: false, env: {}, error: `env value for "${key}" must be a string` };
    }
    if (value.length > MAX_ENV_VALUE_LENGTH) {
      return {
        ok: false,
        env: {},
        error: `env value for "${key}" exceeds ${MAX_ENV_VALUE_LENGTH} chars`,
      };
    }
    out[key] = value;
  }
  return { ok: true, env: out };
}
