// Per-test-file half of the temp guard (docs/plans/TEMP_LEAK_PLAN.md). Runs before
// each test file is imported: the file gets its own temp folder, and after its
// own hooks have run, anything it left there fails it, naming the file.
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, inject, vi } from 'vitest';

const TEMP_VARS = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR'];
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
// Left by programs the tests start, not by Forge code: Node's shared compile
// cache (from a node child process), and Chrome's url-fetcher scratch folder
// (prefixed with the app id on Linux: `com.google.Chrome.chrome_…`).
const NOT_OURS = [/^node-compile-cache$/u, /^([\w.]+\.)?chrome_.*url_fetcher/u];

const fileDir = fs.mkdtempSync(path.join(inject('tempGuardRunDir'), 'file-'));
const savedTempVars = TEMP_VARS.map((name) => [name, process.env[name]] as const);
for (const name of TEMP_VARS) process.env[name] = fileDir;

// The policy file is machine-wide, so a test that calls `loadConfig(dir)` or
// `updateConfigFile()` with no `policyPath` would otherwise read the OWNER's
// `~/.forge/policy.yaml` — and once they have run `Forge: Move security settings
// to policy.yaml`, every unit test would be testing their permissions block
// instead of the fixture's. Stub the default to a path in this file's own temp
// folder that no test creates; an explicit `home` argument still wins, so a test
// that names a fixture home gets that home.
//
// It is stubbed here rather than read from an environment variable in `src/`,
// because an agent's own shell can set one: `setx FORGE_POLICY_PATH
// <workspace>\p.yaml` would make the next VS Code start load its permissions,
// host list and engines from a file the agent can write — the very thing phase
// 3's lock is for. `test/unit/ExecFieldReads.test.ts` fails if `src/` starts
// reading such a variable again.
vi.mock('../../src/config/PolicyLoader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/PolicyLoader')>();
  return {
    ...actual,
    default: actual,
    defaultPolicyPath: (home?: string) =>
      home
        ? path.join(home, '.forge', actual.POLICY_FILENAME)
        : path.join(fileDir, actual.POLICY_FILENAME),
  };
});

// Registered before the test file's own hooks, so with vitest's default `stack`
// hook order it runs after them: the file's cleanup has had its chance.
afterAll(({}, suite) => {
  const testFile = path.relative(REPO_ROOT, suite.file.filepath).split(path.sep).join('/');
  const left = fs.readdirSync(fileDir).filter((name) => !NOT_OURS.some((re) => re.test(name)));
  // Gone in the run folder's teardown if a child still holds it now.
  // A child the test started (Node's compile cache, Chrome's url-fetcher scratch)
  // can hold a file here for seconds when the suite is loaded, and Windows
  // answers EPERM until it lets go; the run folder's teardown takes whatever is
  // still held then. 5 s of retries, so a held file is not read as a leak.
  try {
    fs.rmSync(fileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } finally {
    for (const [name, value] of savedTempVars) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  if (left.length > 0) {
    throw new Error(
      `temp leak: ${testFile} left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in os.tmpdir(): ` +
        `${left.slice(0, 5).join(', ')}${left.length > 5 ? ', …' : ''}. Remove what the test creates ` +
        '(finally / afterEach), or give it a test-owned directory.',
    );
  }
});
