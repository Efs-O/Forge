import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CLOUD_RELAY_ROUTES } from '../../src/llm/CloudRelayServer';
import { STARTER_ROUTES } from '../../src/backend/ModelStarterServer';

const srcRoot = path.resolve(__dirname, '..', '..', 'src');
const read = (...parts: string[]): string => fs.readFileSync(path.join(srcRoot, ...parts), 'utf8');

function imports(source: string): string[] {
  return [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]!);
}

describe('cloud relay surface (CI-enforced ledger row)', () => {
  it('has exactly the nine approved routes', () => {
    expect([...CLOUD_RELAY_ROUTES]).toEqual([
      'GET /v1/models',
      'POST /v1/chat/completions',
      'POST /api/chat',
      'POST /api/generate',
      'GET /v1/media/capabilities',
      'POST /v1/media/jobs',
      'GET /v1/media/job',
      'GET /v1/media/file',
      'POST /v1/media/cancel',
    ]);
  });

  it('keeps every tool factory and every secret reader out of the relay surface', () => {
    // The relay is the one listener a laptop can reach with no token, so the
    // code that answers it may not build a billable tool or read a key:
    // `remoteMediaJobs.ts` does both, behind the port these routes call.
    const files = [
      ['llm', 'CloudRelayServer.ts'],
      ['llm', 'CloudRelayForward.ts'],
      ['media', 'remoteMediaRoutes.ts'],
    ] as const;
    const forbidden =
      /makeGenerateImageTool|makeUpscaleImageTool|makeGenerateVideoTool|makeGenerateMusicTool|SecretStorage|\.secrets\.get\s*\(|api_key_secret/;
    for (const file of files) {
      const source = read(...file);
      expect(source).not.toMatch(forbidden);
      expect(imports(source).filter((name) => /remoteMediaJobs|remoteMediaJobStore/.test(name))).toEqual([]);
    }
    expect(read('media', 'remoteMediaRoutes.ts')).toContain('RemoteMediaPort');
  });

  it('uses the shared 127.0.0.1 listener and leaves :8798 and :8799 surfaces unchanged', () => {
    expect(read('backend', 'TailnetListener.ts')).toContain(".listen(options.port, '127.0.0.1'");
    expect([...STARTER_ROUTES]).toEqual([
      'GET /models',
      'POST /ensure',
      'POST /release',
      'POST /unload',
    ]);
    const control = read('backend', 'ControlServer.ts');
    const routes = new Set<string>(
      [...control.matchAll(/path === '\/([a-z]+)'/g)].map((match) => `/${match[1]}`),
    );
    if (/path\.startsWith\('\/agent\/'\)/.test(control)) routes.add('/agent/*');
    expect([...routes].sort()).toEqual([
      '/agent/*', '/chat', '/ensure', '/healthz', '/models', '/release', '/stats', '/unload',
    ]);
    expect(control).toContain(".listen(port, '127.0.0.1'");
  });

  it('does not import chat, agent or starter modules, or read cloud secrets outside the resolver', () => {
    const files = [
      ['llm', 'CloudRelayServer.ts'],
      ['llm', 'CloudRelayForward.ts'],
    ] as const;
    const forbidden = /ControlServer|ControlChatProxy|agentRoutes|ModelStarter/;
    for (const file of files) {
      const source = read(...file);
      expect(imports(source).filter((name) => forbidden.test(name))).toEqual([]);
      expect(source).not.toMatch(/\.secrets\.get\s*\(|api_key_secret|SecretStorage/);
    }
    expect(read('llm', 'CloudRelayServer.ts')).toContain('resolveCloudRequestTarget(');
  });
});
