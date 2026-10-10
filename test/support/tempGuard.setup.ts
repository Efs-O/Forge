// Per-test-file half of the temp guard (docs/plans/TEMP_LEAK_PLAN.md). Runs before
// each test file is imported: the file gets its own temp folder, and after its
// own hooks have run, anything it left there fails it, naming the file.
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, inject } from 'vitest';

const TEMP_VARS = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR'];
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
// Left by programs the tests start, not by Forge code: Node's shared compile
// cache (from a node child process), and Chrome's url-fetcher scratch folder.
const NOT_OURS = [/^node-compile-cache$/u, /^chrome_.*url_fetcher/u];

const fileDir = fs.mkdtempSync(path.join(inject('tempGuardRunDir'), 'file-'));
for (const name of TEMP_VARS) process.env[name] = fileDir;

// Registered before the test file's own hooks, so with vitest's default `stack`
// hook order it runs after them: the file's cleanup has had its chance.
afterAll(({}, suite) => {
  const testFile = path.relative(REPO_ROOT, suite.file.filepath).split(path.sep).join('/');
  const left = fs.readdirSync(fileDir).filter((name) => !NOT_OURS.some((re) => re.test(name)));
  // Gone in the run folder's teardown if a child still holds it now.
  fs.rmSync(fileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (left.length > 0) {
    throw new Error(
      `temp leak: ${testFile} left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in os.tmpdir(): ` +
        `${left.slice(0, 5).join(', ')}${left.length > 5 ? ', …' : ''}. Remove what the test creates ` +
        '(finally / afterEach), or give it a test-owned directory.',
    );
  }
});
