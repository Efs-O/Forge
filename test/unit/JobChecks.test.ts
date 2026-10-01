import { describe, expect, it } from 'vitest';
import { assetMatches, githubIssueCheck, githubReleaseCheck } from '../../src/jobs/checks/github';
import { hfDiscussionCheck } from '../../src/jobs/checks/huggingface';
import type { CheckContext } from '../../src/jobs/checks/checkTypes';
import type { JobsFetchResult } from '../../src/jobs/jobsFetch';

/** A fake gated fetch that returns a fixed body (or a 304). */
function fakeCtx(body: string | null, etag?: string): CheckContext {
  const result: JobsFetchResult =
    body === null
      ? { notModified: true, body: '', etag: etag ?? null }
      : { notModified: false, body, etag: etag ?? null };
  return {
    fetch: async () => result,
    etagCache: new Map(),
    allowedHosts: ['api.github.com'],
  };
}

const RELEASE_BODY = JSON.stringify({
  tag_name: 'b10910',
  published_at: '2026-09-14T00:00:00Z',
  body: 'New CUDA 13.3 build with flash attention.',
  assets: [
    { name: 'llama-b10910-bin-win-cuda-13.3-x64.zip', digest: 'sha256:abc' },
    { name: 'llama-b10910-bin-macos-arm64.zip', digest: 'sha256:def' },
  ],
});

describe('assetMatches', () => {
  it('matches a glob with *', () => {
    expect(assetMatches('llama-b10910-bin-win-cuda-13.3-x64.zip', '*win-cuda-13.3-x64.zip')).toBe(true);
    expect(assetMatches('llama-b10910-bin-macos-arm64.zip', '*win-cuda-13.3-x64.zip')).toBe(false);
  });
  it('an undefined pattern matches everything', () => {
    expect(assetMatches('anything.zip', undefined)).toBe(true);
  });
});

describe('githubReleaseCheck', () => {
  it('the first run records a baseline and reports no change', async () => {
    const result = await githubReleaseCheck(
      { kind: 'github_release', repo: 'ggml-org/llama.cpp' },
      null,
      fakeCtx(RELEASE_BODY),
    );
    expect(result.changed).toBe(false);
    const obs = JSON.parse(result.observation) as { tag: string; assets: { name: string }[] };
    expect(obs.tag).toBe('b10910');
    // No asset pattern: both assets are recorded (gives summarize content).
    expect(obs.assets).toHaveLength(2);
  });

  it('a tag change is reported as changed', async () => {
    const oldObs = JSON.stringify({ tag: 'b10894', published_at: null, assets: [], body: '' });
    const result = await githubReleaseCheck(
      { kind: 'github_release', repo: 'ggml-org/llama.cpp' },
      oldObs,
      fakeCtx(RELEASE_BODY),
    );
    expect(result.changed).toBe(true);
    expect(result.observation).toContain('b10910');
  });

  it('an ETag 304 counts as unchanged and keeps the last observation', async () => {
    const last = JSON.stringify({ tag: 'b10910' });
    const result = await githubReleaseCheck(
      { kind: 'github_release', repo: 'ggml-org/llama.cpp' },
      last,
      fakeCtx(null, 'W/"etag1"'),
    );
    expect(result.changed).toBe(false);
    expect(result.observation).toBe(last);
    expect(result.summary).toBe('no new release');
  });

  it('a 304 with NO baseline keeps the baseline null, never an empty string', async () => {
    // Reachable when a job's state file was lost while the process kept its
    // ETag cache. Returning '' here is not null, so the NEXT run's
    // `lastObservation !== null` test reports a spurious "changed" — which for
    // a llamacpp_update job is a real install attempt for a release already
    // installed.
    const result = await githubReleaseCheck(
      { kind: 'github_release', repo: 'ggml-org/llama.cpp' },
      null,
      fakeCtx(null, 'W/"etag1"'),
    );
    expect(result.changed).toBe(false);
    expect(result.observation).toBeNull();
  });

  it('an asset pattern filters the recorded assets', async () => {
    const result = await githubReleaseCheck(
      { kind: 'github_release', repo: 'ggml-org/llama.cpp', asset_pattern: '*win-cuda-13.3-x64.zip' },
      null,
      fakeCtx(RELEASE_BODY),
    );
    const obs = JSON.parse(result.observation) as { assets: { name: string }[] };
    expect(obs.assets).toHaveLength(1);
    expect(obs.assets[0]!.name).toBe('llama-b10910-bin-win-cuda-13.3-x64.zip');
  });
});

describe('githubIssueCheck', () => {
  const ISSUE_BODY = JSON.stringify({
    state: 'open',
    updated_at: '2026-09-14T10:00:00Z',
    title: 'Win CUDA build',
    comments: 4,
  });

  it('the first run records a baseline and reports no change', async () => {
    const result = await githubIssueCheck(
      { kind: 'github_issue', repo: 'ggml-org/llama.cpp', issue_number: 1234 },
      null,
      fakeCtx(ISSUE_BODY),
    );
    expect(result.changed).toBe(false);
    const obs = JSON.parse(result.observation) as { state: string; comments: number };
    expect(obs.state).toBe('open');
    expect(obs.comments).toBe(4);
  });

  it('records the last comment id, author, and bounded excerpt', async () => {
    const issue = fakeCtx(ISSUE_BODY);
    issue.fetch = async (url) =>
      url.includes('/comments?')
        ? {
            notModified: false,
            body: JSON.stringify([{ id: 9, user: { login: 'forge' }, body: 'x'.repeat(250) }]),
            etag: null,
          }
        : { notModified: false, body: ISSUE_BODY, etag: null };
    const result = await githubIssueCheck(
      { kind: 'github_issue', repo: 'ggml-org/llama.cpp', issue_number: 1234 },
      null,
      issue,
    );
    const observation = JSON.parse(result.observation) as { last_comment: { id: number; author: string; excerpt: string } };
    expect(observation.last_comment).toMatchObject({ id: 9, author: 'forge' });
    expect(observation.last_comment.excerpt).toHaveLength(200);
  });

  it('asks for the newest comment as the last one-item page', async () => {
    // The per-issue endpoint ignores sort/direction and lists oldest first.
    const urls: string[] = [];
    const issue = fakeCtx(ISSUE_BODY);
    issue.fetch = async (url) => {
      urls.push(url);
      return url.includes('/comments?')
        ? { notModified: false, body: JSON.stringify([{ id: 12, user: { login: 'b' }, body: 'newest' }]), etag: null }
        : { notModified: false, body: ISSUE_BODY, etag: null };
    };
    await githubIssueCheck({ kind: 'github_issue', repo: 'ggml-org/llama.cpp', issue_number: 1234 }, null, issue);
    expect(urls.find((u) => u.includes('/comments?'))).toMatch(/[?&]per_page=1&page=4$/);
  });

  it('an issue with no comments makes no comments request', async () => {
    const urls: string[] = [];
    const body = JSON.stringify({ state: 'open', updated_at: '2026-09-14T10:00:00Z', title: 't', comments: 0 });
    const issue = fakeCtx(body);
    issue.fetch = async (url) => {
      urls.push(url);
      return { notModified: false, body, etag: null };
    };
    const result = await githubIssueCheck({ kind: 'github_issue', repo: 'ggml-org/llama.cpp', issue_number: 1 }, null, issue);
    expect(urls.some((u) => u.includes('/comments'))).toBe(false);
    expect((JSON.parse(result.observation) as { last_comment: unknown }).last_comment).toBeNull();
  });

  it('a comment count change is reported as changed', async () => {
    const oldObs = JSON.stringify({
      state: 'open',
      updated_at: '2026-09-13T10:00:00Z',
      title: 'Win CUDA build',
      comments: 3,
    });
    const result = await githubIssueCheck(
      { kind: 'github_issue', repo: 'ggml-org/llama.cpp', issue_number: 1234 },
      oldObs,
      fakeCtx(ISSUE_BODY),
    );
    expect(result.changed).toBe(true);
  });

  it('an ETag 304 counts as unchanged', async () => {
    const last = JSON.stringify({ state: 'open', updated_at: 'x', title: '', comments: 0 });
    const result = await githubIssueCheck(
      { kind: 'github_issue', repo: 'ggml-org/llama.cpp', issue_number: 1234 },
      last,
      fakeCtx(null, 'W/"etag2"'),
    );
    expect(result.changed).toBe(false);
    expect(result.observation).toBe(last);
  });
});

describe('hfDiscussionCheck', () => {
  const check = {
    kind: 'hf_discussion' as const,
    repo: 'Jackrong/Qwopus3.8-27B-Flash-V2-GGUF',
    repo_type: 'model' as const,
    discussion_number: 2,
  };
  const comment = (id: string, raw: string) => ({
    id,
    type: 'comment',
    createdAt: '2026-09-23T10:30:56.000Z',
    author: { name: 'Efso' },
    data: { latest: { raw } },
  });
  const thread = (status: string, events: object[]) => JSON.stringify({ status, title: 't', events });

  it('fetches the model discussion API and records a baseline without a change', async () => {
    const urls: string[] = [];
    const ctx = fakeCtx(thread('open', [comment('a', 'hi')]));
    const r = await hfDiscussionCheck(check, null, { ...ctx, fetch: (u) => (urls.push(u), ctx.fetch(u)) });
    expect(urls).toEqual([
      'https://huggingface.co/api/models/Jackrong/Qwopus3.8-27B-Flash-V2-GGUF/discussions/2',
    ]);
    expect(r.changed).toBe(false);
    expect(JSON.parse(r.observation!)).toMatchObject({ status: 'open', events: 1 });
  });

  it('a new comment or a status change is a change; an edited comment is not', async () => {
    const base = (await hfDiscussionCheck(check, null, fakeCtx(thread('open', [comment('a', 'hi')])))).observation;
    const edited = await hfDiscussionCheck(check, base, fakeCtx(thread('open', [comment('a', 'hi (edited)')])));
    expect(edited.changed).toBe(false);
    const reply = await hfDiscussionCheck(check, base, fakeCtx(thread('open', [comment('a', 'hi'), comment('b', 'ok')])));
    expect(reply.changed).toBe(true);
    expect(reply.summary).toContain('2 events');
    const closed = await hfDiscussionCheck(check, base, fakeCtx(thread('closed', [comment('a', 'hi')])));
    expect(closed.changed).toBe(true);
  });

  it('a 304 keeps the last observation, even a null baseline', async () => {
    expect(await hfDiscussionCheck(check, null, fakeCtx(null))).toMatchObject({ observation: null, changed: false });
  });

  it('an error payload throws with the API message', async () => {
    await expect(hfDiscussionCheck(check, null, fakeCtx(JSON.stringify({ error: 'Repository not found' })))).rejects.toThrow(
      'Repository not found',
    );
  });
});
