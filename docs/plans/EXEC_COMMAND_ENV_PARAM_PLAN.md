# Plan: controlled `env` parameter for `exec_command`

Status: **implemented 2026-09-12.** `exec_command` accepts a small, validated `env`
object — `src/tools/execEnvPolicy.ts` (pure denylist of dangerous names + key-shape and
size caps), threaded into both the foreground (`spawnAndWait extraEnv`) and background
(`BackgroundExecutionManager.start env`) paths. `shell: false` is preserved at both
spawn sites; no `cmd /c`, `powershell -Command`, or generic `.cmd`/`.bat` execution was
introduced. 62 unit tests in `test/unit/execEnvPolicy.test.ts` plus 3 integration tests
in `test/unit/execTools.test.ts`. Full non-live suite green.

## 1. Goal

Let `exec_command` accept a small, validated `env` object so a model can pass
environment variables to the spawned process. This unblocks the VSIX install
(`ELECTRON_RUN_AS_NODE=1`) and the general class of "a CLI needs an env var"
(proxy, `CI`, `NODE_ENV`, app config), which `exec_command` currently cannot
express because it has no env channel.

**This is option #2 from the prior session's three options — deliberately NOT
#1 (a general `.cmd`/`.bat` launcher) and NOT #3 (a VSIX-specific tool).**
It is a small extension of the existing execution architecture, not a new
execution path.

## 2. Why NOT option #1 (the safety verdict)

Option #1 proposed letting `exec_command` spawn `.cmd`/`.bat` targets by
wrapping them as `cmd.exe /c <target> <args>`. That is the *least* safe of the
three and contradicts the tool's design:

- `exec_command` spawns with `shell: false` (`src/util/processSpawn.ts`). The
  whole security model is that **no shell ever sees the arguments**: an operator
  character *inside* an argument is passed verbatim to the program.
- `checkShellOperators` (`src/tools/execHelpers.ts`) only refuses **bare**
  operator tokens (`&&`, `|`, `&`, `;`, …). A `&`, `^`, or `%` *inside* a path
  argument passes the guards on purpose, because under `shell: false` it is
  inert.
- Wrapping as `cmd /c <target> <args>` makes **`cmd` re-parse its whole command
  line**. That `&` inside the path that passed the guards becomes a command
  separator to `cmd`. Model-authored content reaches a shell parser — the exact
  thing `shell: false` + the guards exist to prevent.

`src/tools/execProgramResolver.ts` says this out loud: it deliberately resolves
only a *closed* set (npm/npx → `node.exe cli.js`) and refuses a general launcher
because *"a general .cmd/.bat launcher would hand back the shell that
`shell: false` exists to withhold."* npm works because its `.cmd` is a **node
shim** the resolver reduces to `node.exe` + `cli.js`; `code.cmd` is a genuine
batch program and cannot be reduced that way. There is no safe general `.cmd`
launcher.

**Architectural invariant for this plan (hard constraint):** do not introduce
`cmd.exe /c`, `powershell -Command`, `shell: true`, or generic `.cmd`/`.bat`
execution anywhere. The env values are passed to the process environment
directly; they are never shell-parsed.

## 3. What the VSIX install actually needs (confirmed)

`code.cmd` (read from `N:\VScode\Microsoft VS Code\bin\code.cmd`) is:

```bat
@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\Code.exe" "%~dp0..\645f29cc31\resources\app\out\cli.js" %*
IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%
endlocal
```

So the batch launcher is *only* setting `ELECTRON_RUN_AS_NODE=1` (and clearing
`VSCODE_DEV`, which is unset in a production install anyway) and invoking the
real `Code.exe` with the `cli.js` path. That reproduces cleanly through the
existing `shell: false` machinery + an `env` param:

- **Program:** `N:\VScode\Microsoft VS Code\Code.exe` — a real `.exe`,
  spawnable with `shell: false`.
- **env:** `{ "ELECTRON_RUN_AS_NODE": "1" }` (minimal; `VSCODE_DEV` clearing is
  optional and not load-bearing for a production install).
- **args:** `[ "<installRoot>\<commitHash>\resources\app\out\cli.js",
  "--install-extension", "<vsix>" ]`.

`Code.exe` under `ELECTRON_RUN_AS_NODE=1` runs as Node using **Electron's
bundled Node** — the correct runtime for `cli.js`. This is why the prior
session's bare `node.exe cli.js` attempt failed ("Failed to identify CommonJS
module resolution conditions"): the system `node.exe` is the wrong runtime;
`Code.exe` is not.

> **Confirm at implementation:** the `645f29cc31` segment is the VS Code
> **product commit hash** and changes on every VS Code update. Do **not**
> hardcode it. Resolve the `cli.js` path at runtime: the install root contains
> exactly one top-level directory (the commit hash) that holds
> `resources/app/out/cli.js`. `fs.readdirSync(installRoot)` and pick the entry
> where `resources/app/out/cli.js` exists. (The `bin\code.cmd` shim is the
> authoritative reference for the shape; the hash is the only moving part.)

> **Note:** `code.cmd`'s existence is *not* justification for supporting
> arbitrary `.cmd` files. It is evidence only that the real invocation is
> `Code.exe` + `ELECTRON_RUN_AS_NODE=1` + `cli.js`, which we reproduce directly.

## 4. The env policy (the security-sensitive core)

With `shell: false`, an env value is **never shell-parsed**, so a value like
`; rm -rf /` is inert to the shell. The real risk is an env var that the
**program's own runtime** reads to load code or redirect behavior. The policy is
therefore a **denylist of dangerous *names*** (defense-in-depth on top of
`shell: false`), plus key-shape and size caps. Values are otherwise free.

### 4.1 Blocked names (case-insensitive on all platforms)

Node/Electron runtime injection (highest risk):
- `NODE_OPTIONS` (`--require`/`--import`/`--experimental-*` = arbitrary code)
- `NODE_PATH` (module-resolution redirection)
- `NODE_EXTRA_CA_CERTS` (TLS MITM)
- `NODE_TLS_REJECT_UNAUTHORIZED` (disable TLS verification)
- `NODE_COMPILE_CACHE` (point at a hostile cache dir)

Dynamic-loader / interpreter startup hooks (cross-language):
- `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `LD_DEBUG` (Linux)
- `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, and any `DYLD_*` (macOS)
- `PYTHONSTARTUP`, `PYTHONPATH`, `PYTHONHOME`
- `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `CLASSPATH`, `JDK_JAVA_OPTIONS`
- `DOTNET_STARTUP_HOOKS`, `DOTNET_ADDITIONAL_DEPS`
- `RUBYOPT`, `PERL5LIB`, `PERLLIB`, `PERL5OPT`
- `BASH_ENV`, `ENV` (shell startup scripts — only matters if the program sources
  them, but block anyway)

Identity / config redirection:
- `PATH`, `PATHEXT`, `COMSPEC`
- `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TMP`, `TMPDIR`, `TEMP`
- `npm_config_*` prefix, `npm_execpath`, `npm_lifecycle_*` (npm behavior /
  `npm_execpath` can make npm run a different script)
- `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_*` prefix

### 4.2 Key shape and size rules

- **Key pattern:** `/^[A-Za-z_][A-Za-z0-9_]{0,127}$/`. This is the standard env
  var name shape; it also rejects any key containing spaces or shell metachars.
  (Windows allows exotic names, but a model-facing tool does not need them.)
- **Max vars:** 32.
- **Max value length:** 8192 chars each.
- **Values:** must be strings (reject non-strings rather than coerce).
- Empty `env` / omitted `env` is valid (no change to current behavior).

### 4.3 Why a denylist, not an allowlist

An allowlist would make the tool useless for its purpose ("CLI needs an env
var" is open-ended by definition). The denylist catches the *dangerous* names;
the load-bearing boundary is still `shell: false`. The denylist is
**defense-in-depth, not the whole story** — a new dangerous var name is a
variant to add, not a hole.

## 5. Where the code lives

- **New module `src/tools/execEnvPolicy.ts`** — pure, unit-testable, single
  responsibility (the denylist + `validateExecEnv`). It must NOT go in
  `execHelpers.ts`, which imports `vscode` and is therefore not unit-testable
  outside the extension host (see the comment at the top of
  `src/util/processSpawn.ts`). A dedicated module also matches the existing
  one-concern-per-module pattern (`DenyList.ts`, `execProgramResolver.ts`,
  `safePowerShellTool.ts`).
- **`src/tools/execTools.ts`** — add the `env` schema property and the
  validation call; thread the validated env into both spawn paths.
- **`src/tools/BackgroundExecutionManager.ts`** — add an `env` field to
  `BackgroundExecutionStartOptions` and merge it into the spawn env, so a
  background `exec_command` with `env` is consistent with the foreground path
  (today the background manager builds its own env and would silently drop it).

`spawnAndWait` **already** has an `extraEnv` parameter
(`src/util/processSpawn.ts`) — the foreground path just passes `{}` today. No
change needed there.

## 6. Changes, in detail

### 6.1 New: `src/tools/execEnvPolicy.ts`

```ts
export interface ExecEnvResult {
  ok: boolean;
  env: Record<string, string>;
  error?: string;
}

export const MAX_ENV_VARS = 32;
export const MAX_ENV_VALUE_LENGTH = 8192;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// Lowercased. See §4.1 for the rationale per name.
const BLOCKED_ENV_NAMES = new Set<string>([
  // Node / Electron runtime injection
  'node_options', 'node_path', 'node_extra_ca_certs',
  'node_tls_reject_unauthorized', 'node_compile_cache',
  // Dynamic-loader / interpreter startup hooks
  'ld_preload', 'ld_library_path', 'ld_audit', 'ld_debug',
  'pythonstartup', 'pythonpath', 'pythonhome',
  'java_tool_options', '_java_options', 'classpath', 'jdk_java_options',
  'dotnet_startup_hooks', 'dotnet_additional_deps',
  'rubyopt', 'perl5lib', 'perllib', 'perl5opt',
  'bash_env', 'env',
  // Identity / config redirection
  'path', 'pathext', 'comspec',
  'home', 'userprofile', 'appdata', 'localappdata', 'tmp', 'tmpdir', 'temp',
  'git_dir', 'git_work_tree',
  'npm_execpath',
]);
// Prefixes are matched separately (npm_config_*, npm_lifecycle_*, git_config_*,
// dyld_* — the last covers DYLD_INSERT_LIBRARIES / DYLD_LIBRARY_PATH / any DYLD_*).
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
    return { ok: false, env: {}, error: `env has ${entries.length} vars; max is ${MAX_ENV_VARS}` };
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!ENV_KEY_PATTERN.test(key)) {
      return { ok: false, env: {}, error: `env key "${key}" is not a valid variable name` };
    }
    const lower = key.toLowerCase();
    if (BLOCKED_ENV_NAMES.has(lower)) {
      return { ok: false, env: {}, error: `env key "${key}" is not allowed for exec_command` };
    }
    if (BLOCKED_ENV_PREFIXES.some((p) => lower.startsWith(p))) {
      return { ok: false, env: {}, error: `env key "${key}" is not allowed for exec_command` };
    }
    if (typeof value !== 'string') {
      return { ok: false, env: {}, error: `env value for "${key}" must be a string` };
    }
    if (value.length > MAX_ENV_VALUE_LENGTH) {
      return { ok: false, env: {}, error: `env value for "${key}" exceeds ${MAX_ENV_VALUE_LENGTH} chars` };
    }
    out[key] = value;
  }
  return { ok: true, env: out };
}
```

> **Type note (future reference).** `ExecEnvResult.error` is `error?: string`
> (optional), so at the call site `envCheck.error` is `string | undefined` while
> `ExecCommandError`'s third parameter is a required `string`. The implementation
> therefore uses `envCheck.error ?? 'invalid env'`. The fallback is **dead code at
> runtime** — every `ok: false` path above returns a non-empty `error` — it exists
> only to satisfy `tsc` (the `TS2345` it silences). If you ever switch the return
> type to a discriminated union
>
> ```ts
> export type ExecEnvResult =
>   | { ok: true; env: Record<string, string> }
>   | { ok: false; env: Record<string, string>; error: string };
> ```
>
> then `if (!envCheck.ok)` narrows to the branch where `error: string` is required
> and the `?? 'invalid env'` fallback disappears entirely. Cost of that switch: the
> three test assertions in `test/unit/execEnvPolicy.test.ts` that read
> `result.error` each need an `if (!result.ok)` guard to narrow, because
> `.toBe(false)` alone does not narrow the type.
>
> The fallback was left in place deliberately (see the decision to keep the simple
> optional-error shape rather than restructure the tests).

### 6.2 `src/tools/execTools.ts` — `makeExecCommandTool`

1. Add to the JSON schema (the schema already has `additionalProperties: false`):

```ts
env: {
  type: 'object',
  additionalProperties: { type: 'string' },
  description:
    'Optional environment variables for the process. A small, validated set — ' +
    'dangerous names (NODE_OPTIONS, PATH, LD_PRELOAD, …) are refused. ' +
    'Use for CLIs that need an env var (e.g. ELECTRON_RUN_AS_NODE).',
},
```

2. In the handler, after the existing guards (with the other pre-spawn checks),
   validate and thread:

```ts
const envCheck = validateExecEnv(args['env'] as Record<string, unknown> | undefined);
if (!envCheck.ok) {
  throw new ExecCommandError('policy_refusal', command, envCheck.error);
}
```

3. Foreground: pass `envCheck.env` in place of the current `{}`:

```ts
const result = await spawnAndWait(
  spawned.command,
  spawned.args,
  cwd,
  timeoutMs,
  envCheck.env,          // was {}
  context?.abortSignal,
);
```

4. Background: pass `envCheck.env` to the manager (new field, §6.3):

```ts
const started = backgroundExecutionManager.start({
  command: spawned.command,
  args: spawned.args,
  cwd,
  timeoutMs: requestedTimeoutMs,
  env: envCheck.env,
});
```

### 6.3 `src/tools/BackgroundExecutionManager.ts`

1. Add to `BackgroundExecutionStartOptions`:

```ts
/** Optional validated env for the child; merged over the inherited env. */
env?: NodeJS.ProcessEnv;
```

2. In `start`, merge it (after `NO_COLOR`/`FORCE_COLOR` so those still win):

```ts
const process = spawn(options.command, [...options.args], {
  shell: false,
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...globalThis.process.env, ...options.env, NO_COLOR: '1', FORCE_COLOR: '0' },
});
```

## 7. Tests

New `test/unit/execEnvPolicy.test.ts` (pure — no `vscode` import, runs in the
fast unit set):

- **Allow:** `{ ELECTRON_RUN_AS_NODE: '1' }` → `ok`, env preserved.
- **Allow:** empty / omitted → `ok`, `{}`.
- **Block by name:** each of `NODE_OPTIONS`, `PATH`, `LD_PRELOAD`,
  `PYTHONPATH`, `npm_execpath`, `JAVA_TOOL_OPTIONS`, `HOME` → `ok: false`.
- **Block by prefix:** `npm_config_registry`, `git_config_global` → `ok: false`.
- **Case-insensitive:** `Node_Options`, `Path` → `ok: false`.
- **Bad key shape:** `''`, `'has space'`, `'a;b'`, a 200-char name → `ok: false`.
- **Non-string value:** `{ FOO: 1 }` → `ok: false`.
- **Oversize value:** a 9000-char value → `ok: false`.
- **Too many vars:** 33 entries → `ok: false`; 32 → `ok`.

`test/unit/execTools.env.test.ts` (or extend an existing exec-tools test) —
integration of the handler:

- `exec_command` with `env: { ELECTRON_RUN_AS_NODE: '1' }` does not throw a
  `policy_refusal` and reaches the spawn (assert via a trivial program, e.g.
  `node -e` is not available shell-free, so use a real executable that prints
  an env var, or assert the resolved invocation).
- `exec_command` with `env: { NODE_OPTIONS: '...' }` throws a `policy_refusal`
  whose message names the blocked key.

`test/unit/BackgroundExecutionManager.test.ts` (extend):

- `start({ env: { FOO: 'bar' } })` produces a child whose env includes `FOO`
  (spawn a program that echoes it, or assert on the merged env object the
  manager would build).

Run: `npm test` (the non-live set).

## 8. Validation / verification (the report the implementer owes)

1. **Files changed** — list.
2. **Exact env policy / blocked variables** — the §4.1 set + key/size rules.
3. **Exact VSIX invocation chosen** — program, env, args (with the runtime
   `cli.js` resolution, §3).
4. **Tests added** — the §7 list.
5. **Confirmation** that no `shell: true`, `cmd /c`, `powershell -Command`, or
   generic `.cmd`/`.bat` execution path was introduced (grep the diff).

## 9. Out of scope / caveats

- **The running session is still the pre-reload build.** Even after 0.15.37 is
  on disk, the active window runs the old code until a **Reload Window** — which
  the agent cannot do from Telegram (it would kill its own process mid-turn).
  The reload step is the user's, at the machine.
- **This does not add a new low-level capability.** `spawnAndWait` already has
  `extraEnv`; this plan exposes it safely at the `exec_command` boundary and
  makes the background path consistent. That is why #2 is much smaller than it
  looks.
- **The denylist is defense-in-depth.** The load-bearing boundary is
  `shell: false`. A genuinely new dangerous var name is a one-line addition, not
  a redesign.

## Acceptance criteria

Each item is an invariant or edge case, mapped to the test or named validation
step that proves it.

- [ ] **No shell is introduced.** The diff contains no `shell: true`, no
      `cmd /c`, no `powershell -Command`, no `.cmd`/`.bat` spawn. → Validation
      step 5 (grep the diff) + code review of §6.
- [ ] **`shell: false` is preserved** at both spawn sites. → Inspect
      `processSpawn.ts` (unchanged) and the `BackgroundExecutionManager.start`
      spawn (still `shell: false`).
- [ ] **Omitted/empty `env` is a no-op** — current behavior unchanged. →
      `execEnvPolicy.test.ts` "empty / omitted → ok, `{}`" + the foreground
      path passing `{}` when `env` is absent.
- [ ] **The VSIX env is accepted.** `ELECTRON_RUN_AS_NODE=1` passes validation.
      → `execEnvPolicy.test.ts` "Allow: `{ ELECTRON_RUN_AS_NODE: '1' }`".
- [ ] **Every blocked name is refused** (case-insensitive). →
      `execEnvPolicy.test.ts` "Block by name" + "Case-insensitive".
- [ ] **Blocked prefixes are refused.** `npm_config_*`, `npm_lifecycle_*`,
      `git_config_*`. → `execEnvPolicy.test.ts` "Block by prefix".
- [ ] **Malformed keys are refused** (empty, spaces, metachars, >128 chars). →
      `execEnvPolicy.test.ts` "Bad key shape".
- [ ] **Non-string and oversized values are refused.** → `execEnvPolicy.test.ts`
      "Non-string value" + "Oversize value".
- [ ] **The 32-var cap holds** (32 ok, 33 refused). → `execEnvPolicy.test.ts`
      "Too many vars".
- [ ] **Foreground and background agree.** A background `exec_command` with
      `env` reaches the child (no silent drop). →
      `BackgroundExecutionManager.test.ts` env-merge test + handler threading in
      §6.2(4).
- [ ] **`NO_COLOR`/`FORCE_COLOR` still win** over a user-supplied env in both
      paths. → Inspect the merge order in §6.3(2) (user env spread *before*
      `NO_COLOR`/`FORCE_COLOR`).
- [ ] **The `cli.js` path is resolved at runtime**, not hardcoded to a commit
      hash. → Validation step 3 + the §3 "Confirm at implementation" note.
- [ ] **`npm test` is green** on the non-live set. → Validation step (run
      `npm test`).
